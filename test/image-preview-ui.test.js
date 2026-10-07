'use strict';
// docs/plans/image-preview.md I2: the image preview (renderer/components/image-preview.js) inside the
// mounted diff view on the fake DOM of test/renderer-harness.js — panes, metadata, the delta, the
// header badge, Fit / 100%, decode failures, Load preview, the binary fallback — and the page's CSP
// and script order (renderer/index.html).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./renderer-harness.js');

const R_ = (f) => path.join(__dirname, '..', 'renderer', f);
const SHA = 'b'.repeat(40);
const KB = 1024;
const MB = 1024 * KB;

const binaryDiff = (file) => {
  const f = { oldPath: file, newPath: file, hunks: [], isBinary: true, oldMode: '100644', newMode: '100644' };
  return { file: f, sections: [f], fingerprint: null, truncated: false, conflict: null };
};
const imageSide = (side, key, extra = {}) => ({
  side, kind: 'image', source: 'commit', key, size: 100 * KB, format: 'png', extensionHint: 'png', mime: 'image/png',
  mismatch: false, dims: { width: 512, height: 512 }, animated: false, bytes: new Uint8Array([1, 2, 3]), ...extra,
});
const other = (side, kind, extra = {}) => ({ ...imageSide(side, `k-${side}`, extra), kind, mime: null, bytes: undefined, ...extra });

/** The diff view mounted on a fake DOM over a loaded store; commit b's `file` diff opened (binary). */
async function mount(tc, { file = 'img/logo.png' } = {}) {
  let n = 0;
  const urlApi = { createObjectURL: () => `blob:file:///u${++n}`, revokeObjectURL() {} };
  const { win, api, store } = await H.loadedStore(H.repoData({ commits: [H.commit(SHA, ['a']), H.commit('a')] }), { urlApi });
  const dom = H.componentDom();
  Object.defineProperty(globalThis, 'document', { value: dom.doc, configurable: true, writable: true });
  win.addEventListener = dom.win.addEventListener;
  win.removeEventListener = dom.win.removeEventListener;
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  for (const f of ['actions.js', 'components/diff-model.js', 'components/diff-staging.js', 'components/image-preview.js', 'components/diff-view.js']) {
    delete require.cache[require.resolve(R_(f))];
    require(R_(f));
  }
  const root = dom.doc.createElement('section');
  root.dataset.component = 'diff-view';
  dom.doc.body.append(root);
  const unmount = win.Components.mountAll({ querySelectorAll: () => [root], contains: (x) => x === root }, store);
  let disposed = false;
  const dispose = () => { if (!disposed) { disposed = true; unmount(); } };
  tc.after(dispose);
  const spec = { kind: 'commit', sha: SHA, file };
  store.actions.openDiff(spec);
  api.take('commitDiffView').resolve(binaryDiff(file));
  await H.flush();
  const q = (sel) => root.querySelector(sel);
  const qa = (sel) => root.querySelectorAll(sel);
  const land = async (oldSide, newSide) => {
    if (oldSide) api.take('commitImageSide', (c) => c.args[3] === 'old').resolve(oldSide);
    if (newSide) api.take('commitImageSide', (c) => c.args[3] === 'new').resolve(newSide);
    await H.flush();
  };
  const texts = (sel) => qa(sel).map((x) => x.textContent);
  const badges = () => texts('.dv-badge');
  /** Fire an <img>'s load with its natural size (what Chromium measured), in a stage of `box`. */
  const loaded = (img, width, height, box = { width: 424, height: 324 }) => {
    const stage = img.parentNode;
    stage.clientWidth = box.width;
    stage.clientHeight = box.height;
    img.naturalWidth = width;
    img.naturalHeight = height;
    dom.dispatch(img, 'load');
  };
  return { win, api, store, dom, root, spec, q, qa, land, texts, badges, loaded, dispose };
}

test('preview: Before / After images instead of the binary message, with metadata, the delta and an image badge', async (tc) => {
  const t = await mount(tc);
  assert.ok(t.q('.ip'), 'the preview replaces the binary message');
  assert.equal(t.q('.dv-message'), null);
  assert.deepEqual(t.texts('.ip-pane-title'), ['Before', 'After']);
  assert.deepEqual(t.texts('.ip-state'), ['Loading image…', 'Loading image…']);
  assert.equal(t.q('.ip-loading') !== null, true, 'the loading text appears after a CSS delay (no flash)');
  assert.deepEqual(t.badges(), ['bbbbbbb', 'image'], 'by extension while loading');
  assert.equal(t.root.querySelector('[role="group"]').getAttribute('aria-label'), 'Image preview');

  await t.land(imageSide('old', 'k1'), imageSide('new', 'k2', { format: 'webp', mime: 'image/webp', size: 100 * KB + 12698, dims: { width: 1024, height: 1024 }, animated: true }));
  const imgs = t.qa('img');
  assert.equal(imgs.length, 2);
  assert.deepEqual(imgs.map((i) => i.src), ['blob:file:///u1', 'blob:file:///u2']);
  assert.deepEqual(imgs.map((i) => i.alt), ['Before: logo.png (PNG, 512×512)', 'After: logo.png (WebP, 1,024×1,024)']);
  assert.equal(imgs[0].decoding, 'async');
  assert.deepEqual(t.texts('.ip-meta'), ['PNG · 512×512 · 100 KB', 'WebP · animated · 1,024×1,024 · 112.4 KB']);
  assert.deepEqual(t.texts('.ip-fact'), ['+12.4 KB (+12.4%)', 'Dimensions 512×512 → 1,024×1,024', 'Format PNG → WebP']);
  assert.ok(t.q('.ip-fact-size').classList.contains('ip-grew'));
  assert.deepEqual(t.badges(), ['bbbbbbb', 'image']);
  assert.equal(t.qa('svg').length, 0);
  t.dispose();
});

test('preview: Fit shrinks a large image into its pane and never enlarges a small one; 100% shows natural size', async (tc) => {
  const t = await mount(tc);
  await t.land(imageSide('old', 'k1'), imageSide('new', 'k2'));
  const [a, b] = t.qa('img');
  assert.equal(a.classList.contains('is-sized'), false, 'hidden until it decoded');
  t.loaded(a, 4000, 2000); // box 424×324 less 2×12 padding: 400×300
  t.loaded(b, 16, 16);
  const [a2, b2] = t.qa('img');
  assert.equal(a2, a, 'a redraw keeps the same <img> (no reload)');
  assert.deepEqual([a.style.width, a.style.height], ['400px', '200px']);
  assert.deepEqual([b2.style.width, b2.style.height], ['16px', '16px'], 'an icon stays at 1×');
  assert.ok(a.classList.contains('is-sized'));
  assert.equal(a.alt, 'Before: logo.png (PNG, 4,000×2,000)', 'decoded dimensions win');
  assert.match(t.texts('.ip-meta')[0], /4,000×2,000/);

  const [fit, actual] = t.qa('.ip-zoom-btn');
  assert.deepEqual([fit.getAttribute('aria-pressed'), actual.getAttribute('aria-pressed')], ['true', 'false']);
  actual.click();
  assert.deepEqual([a.style.width, a.style.height], ['4000px', '2000px']);
  assert.deepEqual([fit.getAttribute('aria-pressed'), actual.getAttribute('aria-pressed')], ['false', 'true']);
  assert.ok(t.q('.ip').classList.contains('is-actual'));
  // at 100% the panes scroll together
  const [sa, sb] = t.qa('.ip-stage');
  sa.scrollLeft = 120;
  sa.scrollTop = 40;
  t.dom.dispatch(sa, 'scroll');
  assert.deepEqual([sb.scrollLeft, sb.scrollTop], [120, 40]);
  fit.click();
  assert.equal(a.style.width, '400px');
  t.dispose();
});

test('preview: a side landing redraws in place: the other pane keeps its stage (scroll, focus) and its <img>', async (tc) => {
  const t = await mount(tc);
  t.api.take('commitImageSide', (c) => c.args[3] === 'old').resolve(imageSide('old', 'k1'));
  await H.flush();
  const [stageA] = t.qa('.ip-stage');
  const img = t.q('img');
  stageA.scrollTop = 77;
  stageA.focus();
  assert.equal(t.dom.doc.activeElement, stageA);
  assert.equal(stageA.tabIndex, 0, 'an image pane can be focused to pan it');
  await t.land(null, imageSide('new', 'k2'));
  assert.equal(t.qa('.ip-stage')[0], stageA);
  assert.equal(t.q('img'), img);
  assert.equal(stageA.scrollTop, 77);
  assert.equal(t.dom.doc.activeElement, stageA, 'focus stays');
  t.dispose();
});

test('preview: both sides with the same bytes get an <img> each; an SVG without a size gets the default object size', async (tc) => {
  const t = await mount(tc, { file: 'icon.svg' });
  const svg = (side) => imageSide(side, 'same', { format: 'svg', mime: 'image/svg+xml', dims: null });
  await t.land(svg('old'), svg('new'));
  const imgs = t.qa('img');
  assert.equal(imgs.length, 2, 'one per pane');
  assert.notEqual(imgs[0], imgs[1]);
  assert.equal(imgs[0].src, imgs[1].src, 'one cached URL');
  t.loaded(imgs[0], 0, 0);
  assert.deepEqual([imgs[0].style.width, imgs[0].style.height], ['300px', '150px']);
  assert.ok(imgs[0].classList.contains('is-sized'), 'never stays hidden');
  assert.equal(t.texts('.ip-meta')[0], 'SVG · 100 KB', 'no made-up dimensions');
  t.dispose();
});

test('preview: a decode failure says so in its pane; both failing fall back to the binary message', async (tc) => {
  const t = await mount(tc);
  await t.land(imageSide('old', 'k1'), imageSide('new', 'k2'));
  t.dom.dispatch(t.qa('img')[0], 'error');
  assert.deepEqual(t.texts('.ip-state'), ['Couldn\'t decode this image']);
  assert.equal(t.qa('img').length, 1);
  t.dom.dispatch(t.qa('img')[0], 'error');
  assert.equal(t.q('.ip-panes'), null);
  assert.equal(t.q('.dv-message').textContent, 'Binary file — no preview\nCouldn\'t decode this PNG');
  t.dispose();
});

test('preview: a binary non-image keeps "Binary file — no preview" and the binary badge', async (tc) => {
  const t = await mount(tc, { file: 'data.bin' });
  assert.deepEqual(t.badges(), ['bbbbbbb', 'binary']);
  await t.land(other('old', 'not-image', { format: null, extensionHint: null }), other('new', 'not-image', { format: null, extensionHint: null }));
  assert.equal(t.q('.ip-panes'), null);
  assert.equal(t.q('.dv-message-binary').textContent, 'Binary file — no preview');
  assert.deepEqual(t.badges(), ['bbbbbbb', 'binary']);
  t.dispose();
});

test('preview: a .png holding no image turns the badge back to binary', async (tc) => {
  const t = await mount(tc);
  assert.deepEqual(t.badges(), ['bbbbbbb', 'image']);
  await t.land(other('old', 'not-image', { format: null }), other('new', 'not-image', { format: null }));
  assert.deepEqual(t.badges(), ['bbbbbbb', 'binary']);
  t.dispose();
});

test('preview: too large, Git LFS, unsupported and op errors are messages in their pane; Load preview forces that side', async (tc) => {
  const t = await mount(tc);
  await t.land(
    other('old', 'too-large', { size: 34.2 * MB, soft: true, limit: 'size', max: 20 * MB }),
    other('new', 'unsupported', { format: 'heic', size: 2 * MB }),
  );
  assert.deepEqual(t.texts('.ip-state-text'), ['Large image (34.2 MB)', 'HEIC — preview not supported']);
  assert.equal(t.q('.ip-zoom').hidden, true, 'no zoom without an image');
  const load = t.q('button.ip-load');
  assert.equal(load.textContent, 'Load preview');
  load.click();
  const forced = t.api.take('commitImageSide');
  assert.deepEqual(forced.args, [SHA, 'img/logo.png', null, 'old', { force: true }]);
  assert.deepEqual(t.texts('.ip-state-text')[0], 'Loading image…');
  forced.reject({ message: 'Too many open files', kind: null });
  await H.flush();
  assert.deepEqual(t.texts('.ip-error'), ['Too many open files']);

  t.store.actions.loadImagePreview(t.spec);
  await t.land(
    other('old', 'lfs-pointer', { format: null, size: 130, dims: null, lfs: { oid: 'c'.repeat(64), size: 2.4 * MB } }),
    other('new', 'too-large', { size: 82 * MB, soft: false, limit: 'size', format: null, dims: null }),
  );
  assert.deepEqual(t.texts('.ip-state-text'), ['Stored in Git LFS (2.4 MB) — not loaded', 'Too large to preview (82 MB)']);
  assert.equal(t.q('button.ip-load'), null, 'a hard cap: no Load preview');
  t.dispose();
});

test('preview: an added image shows one "Added" pane; a deleted one "Deleted"; the mismatch note', async (tc) => {
  const t = await mount(tc);
  await t.land(other('old', 'absent', { size: null, key: null, format: null, dims: null }), imageSide('new', 'k2', { format: 'jpeg', mime: 'image/jpeg', mismatch: true }));
  assert.deepEqual(t.texts('.ip-pane-title'), ['Added']);
  assert.ok(t.q('.ip-panes').classList.contains('is-single'));
  assert.equal(t.q('img').alt, 'Added: logo.png (JPEG, 512×512)');
  assert.equal(t.q('.ip-mismatch').textContent, 'content is JPEG, named .png');
  assert.deepEqual(t.texts('.ip-fact'), [], 'no delta for an added file');

  t.store.actions.loadImagePreview(t.spec);
  await t.land(imageSide('old', 'k1'), other('new', 'absent', { size: null, key: null, format: null, dims: null }));
  assert.deepEqual(t.texts('.ip-pane-title'), ['Deleted']);
  t.dispose();
});

test('preview: only the store\'s blob: URLs reach an <img>, and an SVG is only ever an <img>', async (tc) => {
  const t = await mount(tc, { file: 'icon.svg' });
  await t.land(imageSide('old', 'k1', { format: 'svg', mime: 'image/svg+xml' }), imageSide('new', 'k2', { format: 'svg', mime: 'image/svg+xml' }));
  assert.equal(t.qa('img').length, 2);
  assert.equal(t.qa('svg').length + t.qa('object').length + t.qa('iframe').length + t.qa('embed').length, 0);
  const p = t.store.state.imagePreview;
  t.store.set({ imagePreview: { ...p, new: { ...p.new, url: 'javascript:alert(1)' } } });
  assert.deepEqual(t.qa('img').map((i) => i.src), ['blob:file:///u1'], 'a URL the cache didn\'t make is never set');
  t.dispose();
});

test('preview: closing the diff detaches it; switching files never shows the previous file\'s image', async (tc) => {
  const t = await mount(tc);
  await t.land(imageSide('old', 'k1'), imageSide('new', 'k2'));
  t.store.actions.openDiff({ kind: 'commit', sha: SHA, file: 'img/other.png' });
  assert.equal(t.q('img'), null, 'loading the next diff');
  t.api.take('commitDiffView').resolve(binaryDiff('img/other.png'));
  await H.flush();
  assert.equal(t.q('img'), null, 'the new file\'s sides are still loading');
  assert.deepEqual(t.texts('.ip-state'), ['Loading image…', 'Loading image…']);
  t.store.actions.closeDiff();
  assert.equal(t.root.hidden, true);
  assert.equal(t.q('.ip'), null);
  t.dispose();
});

// ------------------------------------------------------------------ the page

test('CSP: index.html allows blob: images (the preview) and nothing else new; the tab strip is unchanged', () => {
  const csp = (f) => /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(fs.readFileSync(R_(f), 'utf8'))[1];
  const directive = (c, name) => c.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `));
  const index = csp('index.html');
  assert.equal(directive(index, 'img-src'), "img-src 'self' data: blob:");
  assert.equal(directive(index, 'default-src'), "default-src 'none'");
  assert.equal(directive(index, 'script-src'), "script-src 'self'");
  assert.equal(directive(index, 'object-src'), "object-src 'none'");
  assert.equal(directive(index, 'media-src'), undefined);
  assert.doesNotMatch(index, /unsafe/);
  assert.equal(directive(csp('tabs.html'), 'img-src'), "img-src 'self' data:");
});

test('index.html loads the preview scripts in dependency order, and its stylesheet', () => {
  const html = fs.readFileSync(R_('index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  const at = (s) => {
    const i = scripts.indexOf(s);
    assert.ok(i >= 0, `${s} is loaded`);
    return i;
  };
  assert.ok(at('../src/error-kinds.js') < at('../src/image-format.js'));
  assert.ok(at('../src/image-format.js') < at('components/image-model.js'));
  assert.ok(at('image-cache.js') < at('store.js'));
  assert.ok(at('components/image-model.js') < at('store.js'), 'the store uses PLImage');
  assert.ok(at('components/image-preview.js') < at('components/diff-view.js'));
  assert.match(html, /<link rel="stylesheet" href="components\/image-preview.css">/);
});
