'use strict';
// Pure presenter of the diff view's image preview (plain script; exposes window.PLImage, and
// module.exports under node for the tests). No DOM. docs/plans/image-preview.md §6.
//
// It decides when a diff gets a preview and what kind (previewKind: a binary file, a text-backed
// image with its Preview | Text choice, a conflicted image), what each pane shows for an ImageSide
// (src/image-preview.js header; the store keeps it without its bytes), the labels, sizes and the
// before / after delta, the zoom (Fit, 100%, steps) and the comparison modes. Format labels come
// from the shared catalogue, src/image-format.js (window.PLImageFormat), which index.html loads
// before this file; a conflict's side names from op-model.js (window.PLOp.conflictSides).
//
// state.imagePreview (renderer/store.js): {spec, conflict, old: Slot, new: Slot, base?: Slot}, Slot
// = {loading, side (ImageSide without bytes) | null, url | null, error | null}; `conflict`: an
// unmerged path, whose old / new / base are its ours / theirs / base stages. `decoded` below is
// what the view measured once an <img> loaded ({width, height}: naturalWidth / naturalHeight, so
// EXIF rotation is applied), and `failed` whether its decode failed.
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

  /** Whether a path names an image by its extension (any catalogue format, tier 2 included). */
  const imagePath = (p) => !!(p && F() && F().formatOfPath(p));

  /**
   * What image preview the loaded diff `data` of `spec` gets, or null (none: the diff's rows or
   * message as before):
   *   'binary'    exactly one section, a binary one, no symlink / submodule mode on either side. A
   *               binary non-image is asked for too (the ops say 'not-image', and the view falls
   *               back to the binary message).
   *   'text'      exactly one section with hunks, a text diff of a file with an image extension (an
   *               SVG, a Git LFS pointer): the view offers Preview | Text.
   *   'conflict'  an unmerged path whose combined diff is binary, or that has none (modify/delete)
   *               and an image extension: its base / ours / theirs stages.
   */
  function previewKind(spec, data) {
    if (!spec || !data) return null;
    if (data.conflict) {
      const c = data.conflict;
      return c.isBinary || ((!c.hunks || !c.hunks.length) && imagePath(spec.file)) ? 'conflict' : null;
    }
    const sections = sectionsOf(data);
    if (sections.length !== 1) return null;
    const f = sections[0];
    if (SPECIAL_MODES.has(String(f.oldMode || '')) || SPECIAL_MODES.has(String(f.newMode || ''))) return null;
    if (f.isBinary) return 'binary';
    return f.hunks && f.hunks.length && (imagePath(spec.file) || imagePath(spec.orig)) ? 'text' : null;
  }

  /** Whether the loaded diff `data` of `spec` gets an image preview (previewKind is not null). */
  const wantsPreview = (spec, data) => previewKind(spec, data) !== null;

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

  /**
   * The dimensions to show: the decoded ones, else the header's. An OS thumbnail's are the
   * original's (the header's): the decoded ones are the thumbnail's.
   */
  function dimsOf(side, decoded) {
    if (side && side.thumbnail && side.dims) return side.dims;
    return decoded && decoded.width > 0 ? decoded : (side && side.dims) || null;
  }

  /**
   * What an OS thumbnail says about itself: 'Preview by macOS', plus ', scaled to 1,024×768' when it
   * is smaller than the original; '' for any other side.
   */
  function thumbnailText(side) {
    const t = side && side.thumbnail;
    if (!t) return '';
    const d = side.dims;
    const scaled = d && t.width > 0 && t.height > 0 && (t.width < d.width || t.height < d.height);
    return `Preview by ${t.by}${scaled ? `, scaled to ${dimsText(t)}` : ''}`;
  }

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
   * didn't decode; `conflict`: a conflict's stage (a missing one was deleted on that side).
   */
  function paneState(slot, { failed = false, conflict = false } = {}) {
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
      case 'lfs-pointer': // the object isn't in the local LFS cache (nothing is ever downloaded)
        return { kind: 'message', text: `Stored in Git LFS (${formatBytes(side.lfs && side.lfs.size)}) — not available locally` };
      case 'unsupported':
        return { kind: 'message', text: `${formatLabel(side.format) || 'This format'} — preview not supported` };
      case 'special':
        return { kind: 'message', text: 'Not a regular file — no preview' };
      case 'absent':
        if (conflict) return { kind: 'message', text: 'Deleted on this side' };
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
   * How the preview body is laid out: {fallback: true, note} (nothing to show on any side: the
   * binary message, plus `note` when an image failed to decode) or {fallback: false, panes:
   * [{which: 'old' | 'new' | 'base', title}]} — 'Before' / 'After', or one pane 'Added' / 'Deleted'
   * when the other side doesn't exist. A conflict: 'Base' (left out when no stage 1), 'Ours (main)',
   * 'Theirs (feature)' (`names`: PLOp.conflictSides' {ours, theirs}, display-safe; plain 'Ours' /
   * 'Theirs' without). `failed`: {old, new, base} decode failures.
   */
  function layout(preview, failed = {}, { names = null } = {}) {
    const conflict = !!(preview && preview.conflict);
    const order = conflict ? ['base', 'old', 'new'] : ['old', 'new'];
    const slots = order.map((w) => (preview ? preview[w] : null));
    if (slots.every((s) => !isPending(s)) && slots.every((s, i) => !isVisual(s, failed[order[i]]))) {
      const bad = slots.find((s, i) => s.side && s.side.kind === 'image' && failed[order[i]]);
      return { fallback: true, note: bad ? `Couldn't decode this ${formatLabel(bad.side.format) || 'image'}` : null };
    }
    if (conflict) {
      const base = slots[0];
      const titled = (which, word, name) => ({ which, title: name ? `${word} (${name})` : word });
      return {
        fallback: false,
        panes: [
          ...(base && base.side && isAbsent(base.side) ? [] : [{ which: 'base', title: 'Base' }]),
          titled('old', 'Ours', names && names.ours), titled('new', 'Theirs', names && names.theirs),
        ],
      };
    }
    const [old, neu] = slots;
    if (old && old.side && isAbsent(old.side)) return { fallback: false, panes: [{ which: 'new', title: 'Added' }] };
    if (neu && neu.side && isAbsent(neu.side)) return { fallback: false, panes: [{ which: 'old', title: 'Deleted' }] };
    return { fallback: false, panes: [{ which: 'old', title: 'Before' }, { which: 'new', title: 'After' }] };
  }

  // ---------------------------------------------------------------- zoom and comparison modes

  /** The zoom steps of zoom in / out (×2 / ÷2), 12.5% to 3200%. */
  const ZOOM_STEPS = Object.freeze([0.125, 0.25, 0.5, 1, 2, 4, 8, 16, 32]);

  /**
   * The zoom after one step in (`dir` > 0) or out from `zoom` ('fit' or a scale), whose scale on
   * screen is `shown` (Fit's computed scale; a number zoom is its own): the next step past it, kept
   * within ZOOM_STEPS.
   */
  function zoomStep(zoom, dir, shown = zoom === 'fit' ? 1 : Number(zoom)) {
    const at = Number.isFinite(shown) && shown > 0 ? shown : 1;
    const eps = 1e-9;
    if (dir > 0) return ZOOM_STEPS.find((z) => z > at + eps) || ZOOM_STEPS[ZOOM_STEPS.length - 1];
    return [...ZOOM_STEPS].reverse().find((z) => z < at - eps) || ZOOM_STEPS[0];
  }

  /** '100%', '12.5%', '3200%': a scale as a percentage. */
  const zoomText = (scale) => `${Number((scale * 100).toFixed(1))}%`;

  /** Above 100% the pixels are drawn as squares (image-rendering: pixelated), so they can be counted. */
  const pixelated = (scale) => Number.isFinite(scale) && scale > 1;

  /** The comparison modes, in the order the mode key (m) cycles them. */
  const MODES = Object.freeze([
    Object.freeze({ id: 'side-by-side', label: 'Side by side', title: 'Before and after next to each other' }),
    Object.freeze({ id: 'swipe', label: 'Swipe', title: 'After over before, revealed up to a divider you drag' }),
    Object.freeze({ id: 'onion', label: 'Onion skin', title: 'After over before, faded by a slider' }),
    Object.freeze({ id: 'difference', label: 'Difference', title: 'The pixels that changed: identical pixels are black' }),
  ]);
  const MODE_IDS = new Set(MODES.map((m) => m.id));

  /** A stored mode id, else 'side-by-side'. */
  const modeOf = (v) => (MODE_IDS.has(v) ? v : 'side-by-side');

  /**
   * Whether the comparison modes apply: Before and After both shown as decoded images (both sides
   * 'image', each with its URL and not failed), not a conflict.
   */
  function canCompare(preview, failed = {}) {
    if (!preview || preview.conflict) return false;
    return ['old', 'new'].every((w) => {
      const s = preview[w];
      return !!(s && !s.error && s.side && s.side.kind === 'image' && s.url && !failed[w]);
    });
  }

  /** The mode after `mode` in MODES (wrapping). */
  function nextMode(mode) {
    const i = MODES.findIndex((m) => m.id === mode);
    return MODES[(i + 1) % MODES.length].id;
  }

  /**
   * The overlay of a comparison mode: both images at one scale, top-left aligned, in a frame of the
   * larger width and height. {scale, frame, old, new} (CSS px sizes), or null without both sizes.
   * `zoom` as for scaledSize; Fit fits the frame into `box`.
   */
  function overlaySize(zoom, a, b, box) {
    const ok = (d) => d && d.width > 0 && d.height > 0;
    if (!ok(a) || !ok(b)) return null;
    const natural = { width: Math.max(a.width, b.width), height: Math.max(a.height, b.height) };
    const scale = zoom === 'fit' ? fitScale(natural, box) : Number(zoom) || 1;
    const px = (d) => ({ width: Math.max(1, Math.round(d.width * scale)), height: Math.max(1, Math.round(d.height * scale)) });
    return { scale, frame: px(natural), old: px(a), new: px(b) };
  }

  /** A swipe divider or onion opacity position (percent) kept in 0-100. */
  const clampPct = (v) => (Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 50);

  /**
   * The metadata line of a pane: ['WebP · animated', '512×512', '148.2 KB', 'Working copy'] (the
   * source only for working-copy diffs; 'LFS <oid>' for a Git LFS pointer or object; for an OS
   * thumbnail of a HEIC / TIFF / PSD, the original's format, dimensions and size, then
   * thumbnailText), and `note` when the content isn't what the name says ('content is PNG, named
   * .webp'). `path`: the side's file path.
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
    if (side.lfs) parts.push(`LFS ${side.lfs.oid.slice(0, 10)}`); // a pointer, or its object from the local LFS cache
    const source = side.thumbnail ? side.thumbnail.from : side.source;
    if (workdir && SOURCES[source]) parts.push(SOURCES[source]);
    if (side.thumbnail) parts.push(thumbnailText(side));
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
    if (previewKind(spec, data) !== 'binary') return 'binary';
    const sides = preview && sameTarget(preview.spec, spec) ? [preview.old, preview.new].map((s) => s && s.side).filter(Boolean) : [];
    const known = sides.filter((s) => !isAbsent(s) && s.kind !== 'special');
    if (known.some((s) => s.format || s.kind === 'lfs-pointer')) return 'image';
    if (known.length && sides.length === 2) return 'binary';
    return F() && (F().formatOfPath(spec.file) || F().formatOfPath(spec.orig)) ? 'image' : 'binary';
  }

  const api = {
    previewKind, wantsPreview, sameTarget, formatBytes, formatLabel, dimsText, isAbsent, delta, deltaParts, fitScale, scaledSize,
    paneState, isVisual, layout, meta, thumbnailText, altText, badge, ZOOM_STEPS, zoomStep, zoomText, pixelated, MODES, modeOf, canCompare,
    nextMode, overlaySize, clampPct,
  };
  if (typeof window !== 'undefined') window.PLImage = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
