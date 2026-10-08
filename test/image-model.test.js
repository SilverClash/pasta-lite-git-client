'use strict';
// The image preview's presenter (renderer/components/image-model.js, window.PLImage): when a diff
// gets a preview and what kind, pane states and messages, labels, sizes, the before / after delta,
// the zoom (Fit / 100% / steps), the comparison modes and a conflict's panes.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./renderer-harness.js');

const I = () => H.loadRenderer().PLImage;

const KB = 1024;
const MB = 1024 * KB;
const binary = (extra = {}) => ({ oldPath: 'a.png', newPath: 'a.png', hunks: [], isBinary: true, oldMode: '100644', newMode: '100644', ...extra });
const data = (sections, extra = {}) => ({ file: sections[0] || null, sections, fingerprint: null, truncated: false, conflict: null, ...extra });
const wd = { kind: 'workdir', file: 'a.png', staged: false, untracked: false };
const cm = { kind: 'commit', sha: 'a'.repeat(40), file: 'a.png' };

/** An ImageSide without its bytes (src/image-preview.js header). */
const side = (which, kind, extra = {}) => ({
  side: which, kind, source: 'commit', key: `k-${which}`, size: 1000, format: 'png', extensionHint: 'png',
  mime: kind === 'image' ? 'image/png' : null, mismatch: false, dims: { width: 10, height: 20 }, animated: false, ...extra,
});
const slot = (s, extra = {}) => ({ loading: false, side: s, url: s && s.kind === 'image' ? `blob:file:///${s.side}` : null, error: null, ...extra });
const LOADING = { loading: true, side: null, url: null, error: null };

// ------------------------------------------------------------------ wantsPreview

test('previewKind / wantsPreview: a binary section, a text diff of an image, a conflicted image; else none', () => {
  const { wantsPreview, previewKind } = I();
  const text = (extra = {}) => binary({ isBinary: false, hunks: [{ header: '@@' }], ...extra });
  assert.equal(previewKind(wd, data([binary()])), 'binary');
  assert.equal(previewKind(cm, data([binary()])), 'binary');
  assert.equal(previewKind(cm, { file: binary() }), 'binary', 'the older single-file shape');
  assert.equal(previewKind({ ...wd, file: 'icon.svg' }, data([text()])), 'text', 'an SVG');
  assert.equal(previewKind(wd, data([text()])), 'text', 'a .png text diff: a Git LFS pointer');
  assert.equal(previewKind({ ...wd, file: 'b.txt', orig: 'a.svg' }, data([text()])), 'text', 'renamed from an image');
  assert.equal(previewKind({ ...wd, file: 'notes.txt' }, data([text()])), null, 'not an image');
  assert.equal(previewKind({ ...wd, file: 'icon.svg' }, data([text({ hunks: [] })])), null, 'no content change (a rename, a mode change)');
  assert.equal(previewKind(wd, data([binary(), binary()])), null, 'a type change keeps its sections');
  assert.equal(previewKind(wd, data([], { conflict: { path: 'a.png', hunks: [], isBinary: true } })), 'conflict');
  assert.equal(previewKind(wd, data([], { conflict: { path: 'a.png', hunks: [] } })), 'conflict', 'modify/delete of an image');
  assert.equal(previewKind({ ...wd, file: 'a.txt' }, data([], { conflict: { path: 'a.txt', hunks: [] } })), null, 'modify/delete of a text file');
  assert.equal(previewKind({ ...wd, file: 'a.svg' }, data([], { conflict: { path: 'a.svg', hunks: [{ header: '@@@', lines: [] }] } })), null, 'a text conflict keeps its combined diff');
  assert.equal(previewKind(wd, data([binary({ newMode: '120000' })])), null, 'symlink');
  assert.equal(previewKind(wd, data([binary({ oldMode: '160000' })])), null, 'submodule');
  assert.equal(previewKind(wd, data([])), null, 'no changes');
  assert.equal(previewKind(wd, null), null, 'not loaded');
  assert.equal(previewKind(null, data([binary()])), null);
  assert.equal(wantsPreview(wd, data([binary()])), true);
  assert.equal(wantsPreview({ ...wd, file: 'icon.svg' }, data([text()])), true);
  assert.equal(wantsPreview({ ...wd, file: 'notes.txt' }, data([text()])), false);
});

test('sameTarget: kind, file, side and commit (a re-made spec of the same file is the same)', () => {
  const { sameTarget } = I();
  assert.equal(sameTarget(wd, { ...wd, untracked: true }), true);
  assert.equal(sameTarget({ ...wd, staged: true, orig: 'o.png' }, { ...wd, staged: true, orig: 'p.png' }), true);
  assert.equal(sameTarget(wd, { ...wd, staged: true }), false);
  assert.equal(sameTarget(wd, { ...wd, file: 'b.png' }), false);
  assert.equal(sameTarget(cm, { ...cm, sha: 'b'.repeat(40) }), false);
  assert.equal(sameTarget(cm, wd), false);
  assert.equal(sameTarget(null, wd), false);
});

// ------------------------------------------------------------------ labels

test('formatBytes: binary units, one decimal (none when whole)', () => {
  const { formatBytes } = I();
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1024), '1 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(148.2 * KB), '148.2 KB');
  assert.equal(formatBytes(34.2 * MB), '34.2 MB');
  assert.equal(formatBytes(82 * MB), '82 MB');
  assert.equal(formatBytes(2.5 * 1024 * MB), '2.5 GB');
  assert.equal(formatBytes(1023.96 * KB), '1024 KB', 'rounding stays in its unit');
  assert.equal(formatBytes(-1), '');
  assert.equal(formatBytes(null), '');
  assert.equal(formatBytes(NaN), '');
});

test('formatLabel / dimsText: the catalogue label, thousands separated dimensions', () => {
  const { formatLabel, dimsText } = I();
  assert.equal(formatLabel('webp'), 'WebP');
  assert.equal(formatLabel('jxl'), 'JPEG XL');
  assert.equal(formatLabel('nope'), '');
  assert.equal(formatLabel(null), '');
  assert.equal(dimsText({ width: 12000, height: 9000 }), '12,000×9,000');
  assert.equal(dimsText({ width: 0, height: 9 }), '');
  assert.equal(dimsText(null), '');
});

test('meta: format (animated), decoded dimensions first, size, source on working-copy diffs, the mismatch note', () => {
  const { meta } = I();
  const s = side('new', 'image', { format: 'webp', animated: true, source: 'worktree', size: 148.2 * KB, dims: { width: 512, height: 512 } });
  assert.deepEqual(meta(s, { workdir: true, path: 'img/a.webp' }), { parts: ['WebP · animated', '512×512', '148.2 KB', 'Working copy'], note: null });
  assert.deepEqual(meta(s, { decoded: { width: 256, height: 128 }, path: 'a.webp' }).parts, ['WebP · animated', '256×128', '148.2 KB'],
    'decoded (EXIF-rotated) dimensions win; no source on a commit diff');
  const mislabeled = side('old', 'image', { format: 'jpeg', extensionHint: 'png', mismatch: true, source: 'index' });
  assert.deepEqual(meta(mislabeled, { workdir: true, path: 'x/Photo.PNG' }), { parts: ['JPEG', '10×20', '1000 B', 'Index'], note: 'content is JPEG, named .png' });
  assert.deepEqual(meta(side('old', 'image', { format: 'ico', dims: { width: 256, height: 256, count: 3 } })).parts, ['ICO', '256×256', '3 sizes', '1000 B']);
  const lfs = side('old', 'lfs-pointer', { format: null, dims: null, size: 130, lfs: { oid: 'ab'.repeat(32), size: 2.4 * MB } });
  assert.deepEqual(meta(lfs).parts, ['130 B', 'LFS ababababab']);
  assert.deepEqual(meta(side('old', 'absent', { size: null })), { parts: [], note: null });
  assert.deepEqual(meta(null), { parts: [], note: null });
});

test('altText: the pane title, the file name and what the image is', () => {
  const { altText } = I();
  assert.equal(altText('Before', 'img/logo.webp', side('old', 'image', { format: 'webp', dims: { width: 512, height: 512 } })), 'Before: logo.webp (WebP, 512×512)');
  assert.equal(altText('After', 'a.svg', side('new', 'image', { format: 'svg', dims: null }), { width: 30, height: 10 }), 'After: a.svg (SVG, 30×10)');
  assert.equal(altText('Added', 'a.bin', side('new', 'image', { format: null, dims: null })), 'Added: a.bin');
});

// ------------------------------------------------------------------ delta

test('delta: size change and percent, dimension and format changes; none without both sides', () => {
  const { delta, deltaParts } = I();
  const a = side('old', 'image', { size: 100 * KB, dims: { width: 512, height: 512 } });
  const b = side('new', 'image', { size: 100 * KB + 12698, format: 'webp', dims: { width: 1024, height: 1024 } });
  const d = delta(a, b);
  assert.equal(d.bytes, 12698);
  assert.ok(Math.abs(d.pct - 12.400390625) < 1e-9);
  assert.deepEqual(d.dims, { from: { width: 512, height: 512 }, to: { width: 1024, height: 1024 } });
  assert.deepEqual(d.format, { from: 'png', to: 'webp' });
  assert.deepEqual(deltaParts(d).map((p) => p.text), ['+12.4 KB (+12.4%)', 'Dimensions 512×512 → 1,024×1,024', 'Format PNG → WebP']);
  assert.equal(deltaParts(d)[0].dir, 1);

  const smaller = delta(b, a);
  assert.deepEqual(deltaParts(smaller).map((p) => p.text)[0], '−12.4 KB (−11.0%)');
  assert.equal(deltaParts(smaller)[0].dir, -1);
  assert.deepEqual(deltaParts(delta(a, { ...a, side: 'new' })), [{ kind: 'size', text: 'Same size', dir: 0 }]);
  assert.equal(delta({ ...a, size: 0 }, b).pct, null, 'old size 0: no percent');
  assert.deepEqual(deltaParts(delta({ ...a, size: 0, kind: 'not-image', source: 'commit' }, b))[0].text, '+112.4 KB');
  assert.equal(delta(side('old', 'absent', { size: null }), b), null, 'added');
  assert.equal(delta(a, side('new', 'absent', { size: null })), null, 'deleted');
  assert.equal(delta(null, b), null);
  assert.deepEqual(deltaParts(null), []);
  // decoded dimensions (EXIF rotation) decide "changed"
  assert.equal(delta(a, { ...a, side: 'new' }, { oldDecoded: { width: 512, height: 512 }, newDecoded: { width: 512, height: 300 } }).dims.to.height, 300);
  assert.equal(delta(a, { ...b, dims: null, format: 'png' }).dims, null, 'unknown dimensions are no change');
});

// ------------------------------------------------------------------ zoom

test('fitScale / scaledSize: Fit shrinks into the box and never enlarges; 100% is the natural size', () => {
  const { fitScale, scaledSize } = I();
  assert.equal(fitScale({ width: 4000, height: 2000 }, { width: 400, height: 400 }), 0.1);
  assert.equal(fitScale({ width: 16, height: 16 }, { width: 400, height: 400 }), 1, 'an icon stays crisp at 1×');
  assert.equal(fitScale({ width: 100, height: 1000 }, { width: 400, height: 250 }), 0.25);
  assert.equal(fitScale({ width: 100, height: 100 }, { width: 0, height: 0 }), 1, 'no layout yet');
  assert.equal(fitScale(null, { width: 10, height: 10 }), 1);
  assert.deepEqual(scaledSize('fit', { width: 4000, height: 3000 }, { width: 400, height: 600 }), { width: 400, height: 300 });
  assert.deepEqual(scaledSize(1, { width: 4000, height: 3000 }, { width: 400, height: 600 }), { width: 4000, height: 3000 });
  assert.deepEqual(scaledSize('fit', { width: 3, height: 5000 }, { width: 400, height: 100 }), { width: 1, height: 100 }, 'at least 1 px');
  assert.equal(scaledSize('fit', { width: 0, height: 0 }, { width: 1, height: 1 }), null);
});

// ------------------------------------------------------------------ panes

test('paneState: every state of a side', () => {
  const { paneState } = I();
  assert.deepEqual(paneState(null), { kind: 'loading' });
  assert.deepEqual(paneState(LOADING), { kind: 'loading' });
  assert.deepEqual(paneState(slot(side('old', 'image'))), { kind: 'image' });
  assert.deepEqual(paneState(slot(side('old', 'image')), { failed: true }), { kind: 'message', text: 'Couldn\'t decode this image' });
  assert.deepEqual(paneState(slot(null, { error: 'boom' })), { kind: 'error', text: 'boom' });
  assert.deepEqual(paneState({ ...LOADING, error: 'boom' }), { kind: 'error', text: 'boom' });
  assert.deepEqual(paneState(slot(side('old', 'too-large', { size: 34.2 * MB, soft: true, limit: 'size', max: 20 * MB }))),
    { kind: 'message', text: 'Large image (34.2 MB)', load: true });
  assert.deepEqual(paneState(slot(side('old', 'too-large', { size: 82 * MB, soft: false, limit: 'size', dims: { width: 12000, height: 9000 } }))),
    { kind: 'message', text: 'Too large to preview (82 MB, 12,000×9,000)' });
  assert.deepEqual(paneState(slot(side('old', 'too-large', { size: 82 * MB, soft: false, limit: 'size', format: null, dims: null }))),
    { kind: 'message', text: 'Too large to preview (82 MB)' }, 'a git side over the cap is never read: no format, no dimensions');
  assert.equal(paneState(slot(side('old', 'too-large', { size: 3 * MB, soft: false, limit: 'pixels', dims: { width: 20000, height: 20000 } }))).text,
    'Too large to preview (3 MB, 20,000×20,000)');
  assert.deepEqual(paneState(slot(side('old', 'lfs-pointer', { format: null, lfs: { oid: 'a'.repeat(64), size: 2.4 * MB } }))),
    { kind: 'message', text: 'Stored in Git LFS (2.4 MB) — not available locally' });
  assert.deepEqual(paneState(slot(side('old', 'unsupported', { format: 'heic' }))), { kind: 'message', text: 'HEIC — preview not supported' });
  assert.deepEqual(paneState(slot(side('old', 'unsupported', { format: 'svgz' }))), { kind: 'message', text: 'SVGZ — preview not supported' });
  assert.deepEqual(paneState(slot(side('old', 'special', { size: null }))), { kind: 'message', text: 'Not a regular file — no preview' });
  assert.deepEqual(paneState(slot(side('new', 'not-image', { format: null }))), { kind: 'message', text: 'Not an image — no preview' });
  assert.deepEqual(paneState(slot(side('new', 'not-image', { format: null, size: 0 }))), { kind: 'message', text: 'Empty file' });
  assert.deepEqual(paneState(slot(side('old', 'absent'))), { kind: 'message', text: 'Added' });
  assert.deepEqual(paneState(slot(side('new', 'absent'))), { kind: 'message', text: 'Deleted' });
});

test('isAbsent: an absent side, or the empty index side of an intent-to-add file', () => {
  const { isAbsent } = I();
  assert.equal(isAbsent(side('old', 'absent')), true);
  assert.equal(isAbsent(side('old', 'not-image', { source: 'index', size: 0, format: null })), true, 'git add -N');
  assert.equal(isAbsent(side('new', 'not-image', { source: 'worktree', size: 0, format: null })), false, 'an emptied file');
  assert.equal(isAbsent(side('old', 'not-image', { source: 'commit', size: 0, format: null })), false);
  assert.equal(isAbsent(side('old', 'image')), false);
  assert.equal(isAbsent(null), false);
});

test('layout: Before / After, one pane for an added or deleted file, the binary message when nothing can be shown', () => {
  const { layout } = I();
  const img = (w) => slot(side(w, 'image'));
  const not = (w) => slot(side(w, 'not-image', { format: null }));
  const titles = (l) => l.panes.map((p) => `${p.which}:${p.title}`);
  assert.deepEqual(titles(layout({ old: img('old'), new: img('new') })), ['old:Before', 'new:After']);
  assert.deepEqual(titles(layout(null)), ['old:Before', 'new:After'], 'loading: both panes');
  assert.deepEqual(titles(layout({ old: LOADING, new: not('new') })), ['old:Before', 'new:After'], 'one side still loading');
  assert.deepEqual(titles(layout({ old: slot(side('old', 'absent')), new: img('new') })), ['new:Added']);
  assert.deepEqual(titles(layout({ old: slot(side('old', 'not-image', { source: 'index', size: 0 })), new: img('new') })), ['new:Added'], 'intent-to-add');
  assert.deepEqual(titles(layout({ old: img('old'), new: slot(side('new', 'absent')) })), ['old:Deleted']);
  assert.deepEqual(titles(layout({ old: img('old'), new: not('new') })), ['old:Before', 'new:After'], 'an image replaced by a non-image');
  assert.deepEqual(titles(layout({ old: slot(side('old', 'unsupported', { format: 'heic' })), new: slot(side('new', 'too-large', { soft: true })) })), ['old:Before', 'new:After']);
  assert.deepEqual(titles(layout({ old: slot(null, { error: 'x' }), new: not('new') })), ['old:Before', 'new:After'], 'an op error is shown in its pane');

  assert.deepEqual(layout({ old: not('old'), new: not('new') }), { fallback: true, note: null }, 'a binary non-image');
  assert.deepEqual(layout({ old: slot(side('old', 'absent')), new: not('new') }), { fallback: true, note: null }, 'an added non-image');
  assert.deepEqual(layout({ old: slot(side('old', 'special', { size: null })), new: not('new') }), { fallback: true, note: null });
  assert.deepEqual(layout({ old: img('old'), new: img('new') }, { old: true, new: true }), { fallback: true, note: 'Couldn\'t decode this PNG' }, 'both fail to decode');
  assert.deepEqual(layout({ old: img('old'), new: not('new') }, { old: true }), { fallback: true, note: 'Couldn\'t decode this PNG' });
  assert.equal(layout({ old: img('old'), new: img('new') }, { old: true }).fallback, false, 'one decode failure: its pane says so');
});

test('isVisual: images, and why one isn\'t shown; not a non-image, an absent side or a failed decode', () => {
  const { isVisual } = I();
  for (const k of ['image', 'too-large', 'lfs-pointer', 'unsupported']) assert.equal(isVisual(slot(side('old', k))), true, k);
  for (const k of ['not-image', 'absent', 'special']) assert.equal(isVisual(slot(side('old', k))), false, k);
  assert.equal(isVisual(slot(side('old', 'image')), true), false);
  assert.equal(isVisual(slot(null, { error: 'x' })), true);
  assert.equal(isVisual(null), false);
});

// ------------------------------------------------------------------ header badge

test('badge: image once a side is an image format or an LFS pointer, by extension while loading; binary otherwise', () => {
  const { badge } = I();
  const d = data([binary()]);
  const pv = (old, neu, spec = cm) => ({ spec, old, new: neu });
  assert.equal(badge(cm, d, null), 'image', 'loading: the .png extension');
  assert.equal(badge({ ...cm, file: 'a.bin' }, d, null), 'binary');
  assert.equal(badge(cm, d, pv(slot(side('old', 'absent')), slot(side('new', 'image')))), 'image');
  assert.equal(badge(cm, d, pv(slot(side('old', 'unsupported', { format: 'heic' })), LOADING)), 'image', 'tier 2 is still an image');
  assert.equal(badge(cm, d, pv(slot(side('old', 'lfs-pointer', { format: null })), LOADING)), 'image');
  assert.equal(badge(cm, d, pv(slot(side('old', 'not-image', { format: null })), slot(side('new', 'not-image', { format: null })))), 'binary',
    'a .png that holds no image');
  assert.equal(badge(cm, d, pv(slot(side('old', 'image')), slot(side('new', 'image')), { ...cm, file: 'other.png' })), 'image',
    'another file\'s preview is ignored (extension)');
  assert.equal(badge(cm, data([binary({ isBinary: false, hunks: [{ header: '@@' }] })]), null), 'binary', 'no preview: the badge rule doesn\'t apply');
});

test('layout: a conflict is Base, Ours (name) and Theirs (name); no base pane without a stage 1; a deleted side says so', () => {
  const { layout, paneState } = I();
  const names = { ours: 'main', theirs: 'feature/x' };
  const c = (base, old, neu) => ({ spec: wd, conflict: true, base, old, new: neu });
  const img = (w) => slot(side(w, 'image'));
  assert.deepEqual(layout(c(img('base'), img('old'), img('new')), {}, { names }).panes,
    [{ which: 'base', title: 'Base' }, { which: 'old', title: 'Ours (main)' }, { which: 'new', title: 'Theirs (feature/x)' }]);
  assert.deepEqual(layout(c(slot(side('base', 'absent')), img('old'), img('new'))).panes.map((x) => x.title), ['Ours', 'Theirs'], 'add/add: no base; no names: plain');
  const gone = slot(side('new', 'absent'));
  assert.deepEqual(layout(c(img('base'), img('old'), gone), {}, { names }).panes.map((x) => x.which), ['base', 'old', 'new']);
  assert.deepEqual(paneState(gone, { conflict: true }), { kind: 'message', text: 'Deleted on this side' });
  assert.equal(layout(c(LOADING, img('old'), img('new'))).fallback, false, 'loading');
  const none = (w) => slot(side(w, 'not-image', { format: null }));
  assert.deepEqual(layout(c(none('base'), none('old'), none('new'))), { fallback: true, note: null }, 'a binary non-image');
  assert.equal(layout(c(none('base'), none('old'), img('new')), { new: true }).fallback, true, 'the one image failed');
});

test('zoomStep / zoomText / pixelated: ×2 / ÷2 steps from 12.5% to 3200%, from Fit at the scale shown', () => {
  const { zoomStep, zoomText, pixelated, ZOOM_STEPS } = I();
  assert.deepEqual([...ZOOM_STEPS], [0.125, 0.25, 0.5, 1, 2, 4, 8, 16, 32]);
  assert.equal(zoomStep(1, 1), 2);
  assert.equal(zoomStep(1, -1), 0.5);
  assert.equal(zoomStep(32, 1), 32, 'kept at the largest');
  assert.equal(zoomStep(0.125, -1), 0.125, 'kept at the smallest');
  assert.equal(zoomStep('fit', 1, 0.37), 0.5, 'from Fit: the next step past the scale on screen');
  assert.equal(zoomStep('fit', -1, 0.37), 0.25);
  assert.equal(zoomStep('fit', 1, 1), 2, 'Fit of a small image is 100%');
  assert.equal(zoomStep('fit', -1, 0.1), 'fit', 'Fit below the smallest step: zoom out stays (never zooms in)');
  assert.equal(zoomStep('fit', 1, 0.1), 0.125);
  assert.deepEqual([zoomText(1), zoomText(0.125), zoomText(32), zoomText(0.37)], ['100%', '12.5%', '3200%', '37%']);
  assert.deepEqual([pixelated(1), pixelated(2), pixelated(0.5), pixelated(NaN)], [false, true, false, false]);
});

test('comparison modes: available for two decoded images only (not a conflict); m cycles them; the overlay frame', () => {
  const { MODES, modeOf, canCompare, nextMode, overlaySize, clampPct } = I();
  assert.deepEqual(MODES.map((m) => m.id), ['side-by-side', 'swipe', 'onion', 'difference']);
  assert.deepEqual([modeOf('swipe'), modeOf('nope'), modeOf(null)], ['swipe', 'side-by-side', 'side-by-side']);
  assert.deepEqual(MODES.map((m) => nextMode(m.id)), ['swipe', 'onion', 'difference', 'side-by-side']);
  const p = (old, neu, extra = {}) => ({ spec: wd, old, new: neu, ...extra });
  const img = (w) => slot(side(w, 'image'));
  assert.equal(canCompare(p(img('old'), img('new'))), true);
  assert.equal(canCompare(p(img('old'), img('new')), { new: true }), false, 'a decode failure');
  assert.equal(canCompare(p(slot(side('old', 'absent')), img('new'))), false, 'added');
  assert.equal(canCompare(p(img('old'), slot(side('new', 'too-large')))), false);
  assert.equal(canCompare(p(img('old'), LOADING)), false);
  assert.equal(canCompare(p(img('old'), img('new'), { conflict: true, base: img('base') })), false, 'a conflict');
  assert.equal(canCompare(null), false);
  // Both at one scale in a frame of the larger width and height; Fit fits the frame.
  assert.deepEqual(overlaySize('fit', { width: 400, height: 100 }, { width: 200, height: 300 }, { width: 200, height: 1000 }),
    { scale: 0.5, frame: { width: 200, height: 150 }, old: { width: 200, height: 50 }, new: { width: 100, height: 150 } });
  assert.deepEqual(overlaySize(2, { width: 4, height: 4 }, { width: 8, height: 2 }, null).frame, { width: 16, height: 8 });
  assert.equal(overlaySize('fit', null, { width: 1, height: 1 }, null), null);
  assert.deepEqual([clampPct(-5), clampPct(105), clampPct(42), clampPct(NaN)], [0, 100, 42, 50]);
});

test('meta: an image from the local Git LFS cache names its object', () => {
  const { meta } = I();
  const s = side('new', 'image', { source: 'lfs-cache', lfs: { oid: 'c0ffee'.padEnd(64, '0'), size: 1000 } });
  assert.deepEqual(meta(s, { workdir: true }).parts, ['PNG', '10×20', '1000 B', 'LFS c0ffee0000']);
});

test('an OS thumbnail (I4): the original\'s format, dimensions, size and source, then who made it and whether it is scaled', () => {
  const { meta, delta, altText, thumbnailText, paneState, canCompare } = I();
  const thumb = (extra = {}, t = {}) => side('new', 'image', {
    source: 'os-thumbnail', format: 'heic', extensionHint: 'heic', dims: { width: 4032, height: 3024 }, size: 2 * MB,
    thumbnail: { by: 'macOS', from: 'worktree', width: 1024, height: 768, ...t }, ...extra,
  });
  const s = thumb();
  const decoded = { width: 1024, height: 768 }; // the <img> holds the thumbnail
  assert.deepEqual(meta(s, { decoded, workdir: true, path: 'IMG_1.HEIC' }).parts,
    ['HEIC', '4,032×3,024', '2 MB', 'Working copy', 'Preview by macOS, scaled to 1,024×768']);
  assert.deepEqual(meta(s, { decoded }).parts, ['HEIC', '4,032×3,024', '2 MB', 'Preview by macOS, scaled to 1,024×768'], 'a commit: no source');
  const small = thumb({ dims: { width: 64, height: 64 } }, { by: 'Windows', from: 'index', width: 64, height: 64 });
  assert.equal(thumbnailText(small), 'Preview by Windows', 'full size: not scaled');
  assert.deepEqual(meta(small, { workdir: true }).parts.slice(-2), ['Index', 'Preview by Windows']);
  assert.equal(thumbnailText(side('new', 'image')), '');
  assert.equal(altText('After', 'a/IMG_1.HEIC', s, decoded), 'After: IMG_1.HEIC (HEIC, 4,032×3,024)');
  // The delta compares the originals' dimensions; the pane shows the image; the modes apply.
  const old = thumb({ side: 'old', dims: { width: 2016, height: 1512 }, size: MB }, { width: 1024, height: 768 });
  assert.deepEqual(delta(old, s, { oldDecoded: decoded, newDecoded: decoded }).dims, { from: { width: 2016, height: 1512 }, to: { width: 4032, height: 3024 } });
  assert.deepEqual(paneState(slot(s)), { kind: 'image' });
  assert.equal(canCompare({ old: slot(old), new: slot(s) }), true);
});

test('the presenter loads under the harness next to the shared catalogue', () => {
  const win = H.loadRenderer();
  assert.equal(typeof win.PLImage.wantsPreview, 'function');
  assert.equal(win.PLImageFormat.FORMATS.webp.label, 'WebP');
  assert.ok(Object.isFrozen(win.PLImageFormat.POLICY));
});
