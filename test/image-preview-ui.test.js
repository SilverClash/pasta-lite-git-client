'use strict';
// docs/plans/image-preview.md I2 / I3: the image preview (renderer/components/image-preview.js) inside
// the mounted diff view on the fake DOM of test/renderer-harness.js — panes, metadata, the delta, the
// header badge, Fit / 100% / zoom steps, decode failures, Load preview, the binary fallback, the
// comparison modes, the image keys, a text-backed SVG's Preview | Text, a conflict's three panes —
// and the page's CSP and script order (renderer/index.html).
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

/**
 * The diff view mounted on a fresh fake DOM over `store` (window `win`). Every test sets up its own
 * document and layout globals (ResizeObserver, requestAnimationFrame), so none relies on one that ran
 * before it. `resize()` runs the ResizeObservers' callbacks, as a layout change would.
 */
function mountView(tc, win, store) {
  const dom = H.componentDom();
  Object.defineProperty(globalThis, 'document', { value: dom.doc, configurable: true, writable: true });
  win.addEventListener = dom.win.addEventListener;
  win.removeEventListener = dom.win.removeEventListener;
  const observers = [];
  globalThis.ResizeObserver = class { constructor(cb) { this.cb = cb; observers.push(this); } observe() {} disconnect() {} };
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
  const resize = () => { for (const o of observers) o.cb([]); };
  return { dom, root, dispose, resize };
}

/** The diff view mounted on a fake DOM over a loaded store; commit b's `file` diff opened (binary, or `diff`). */
async function mount(tc, { file = 'img/logo.png', diff = null, storage = H.memoryStorage() } = {}) {
  let n = 0;
  const urlApi = { createObjectURL: () => `blob:file:///u${++n}`, revokeObjectURL() {} };
  H.setLocalStorage(storage);
  const { win, api, store } = await H.loadedStore(H.repoData({ commits: [H.commit(SHA, ['a']), H.commit('a')] }), { urlApi });
  const { dom, root, dispose, resize } = mountView(tc, win, store);
  const spec = { kind: 'commit', sha: SHA, file };
  store.actions.openDiff(spec);
  api.take('commitDiffView').resolve(diff || binaryDiff(file));
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
  return { win, api, store, dom, root, spec, q, qa, land, texts, badges, loaded, dispose, resize, storage };
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
  const frame = scrolling(t, [[sa, { left: 4000, top: 2000 }], [sb, { left: 4000, top: 2000 }]]);
  sa.scrollLeft = 120;
  sa.scrollTop = 40;
  frame();
  assert.deepEqual([sb.scrollLeft, sb.scrollTop], [120, 40]);
  fit.click();
  assert.equal(a.style.width, '400px');
  t.dispose();
});

/**
 * Stages that scroll like a browser's: a position is clamped to the stage's range (`max`), and a change
 * queues one scroll event per stage, fired by the returned frame() (a frame later, not during the write).
 */
function scrolling(t, stages) {
  const queued = new Set();
  for (const [stage, max] of stages) {
    const pos = { left: 0, top: 0 };
    for (const [prop, k] of [['scrollLeft', 'left'], ['scrollTop', 'top']]) {
      Object.defineProperty(stage, prop, {
        configurable: true,
        get: () => pos[k],
        set: (v) => {
          const n = Math.max(0, Math.min(max[k], Math.round(v)));
          if (n === pos[k]) return;
          pos[k] = n;
          queued.add(stage);
        },
      });
    }
  }
  return () => {
    const due = [...queued];
    queued.clear();
    for (const s of due) t.dom.dispatch(s, 'scroll');
  };
}

test('zoom: the panes scroll together; a mirrored pane\'s own scroll event never pulls the driven one back', async (tc) => {
  const t = await mount(tc);
  await t.land(imageSide('old', 'k1'), imageSide('new', 'k2'));
  const [a, b] = t.qa('img');
  t.loaded(a, 4000, 2000);
  t.loaded(b, 1000, 500);
  t.qa('.ip-zoom-btn')[1].click(); // 100%
  const [sa, sb] = t.qa('.ip-stage');
  // the After image is smaller: its pane scrolls only up to 600 × 200 (1000×500 at 100% in a 400×300 box)
  const frame = scrolling(t, [[sa, { left: 3600, top: 1700 }], [sb, { left: 600, top: 200 }]]);
  sa.scrollLeft = 900;
  sa.scrollTop = 300;
  frame(); // Before's event: After follows, clamped
  assert.deepEqual([sb.scrollLeft, sb.scrollTop], [600, 200]);
  frame(); // After's echo of that write
  assert.deepEqual([sa.scrollLeft, sa.scrollTop], [900, 300], 'the driven pane stays where the user put it');

  // momentum: several writes on Before before After's echo arrives
  sa.scrollLeft = 950;
  frame();
  sa.scrollLeft = 1000;
  sa.scrollTop = 150;
  frame();
  frame();
  assert.deepEqual([sa.scrollLeft, sa.scrollTop], [1000, 150]);
  assert.deepEqual([sb.scrollLeft, sb.scrollTop], [600, 150]);

  // the user scrolls After: Before follows, and After's echo-free event is the user's
  sb.scrollLeft = 100;
  frame();
  frame();
  assert.deepEqual([sa.scrollLeft, sb.scrollLeft], [100, 100]);
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

test('preview: a redraw keeps each pane\'s message: a focused Load preview button stays focused, "Loading image…" keeps its delay', async (tc) => {
  const t = await mount(tc);
  const [, loadingNew] = t.qa('.ip-state');
  t.api.take('commitImageSide', (c) => c.args[3] === 'old').resolve(other('old', 'too-large', { size: 34.2 * MB, soft: true, limit: 'size', max: 20 * MB }));
  await H.flush();
  assert.equal(t.qa('.ip-state')[1], loadingNew, 'the other side\'s "Loading image…" is the same element (its 150 ms delay doesn\'t restart)');
  const load = t.q('button.ip-load');
  load.focus();
  await t.land(null, imageSide('new', 'k2'));
  assert.equal(t.q('button.ip-load'), load, 'the same button');
  assert.equal(t.dom.doc.activeElement, load, 'focus stays on it while the other side lands');
  t.store.set({ imagePreview: { ...t.store.state.imagePreview } });
  assert.equal(t.dom.doc.activeElement, load, 'and through any redraw');
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
  assert.deepEqual(t.texts('.ip-state-text'), ['Stored in Git LFS (2.4 MB) — not available locally', 'Too large to preview (82 MB)']);
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

// ------------------------------------------------------------------ I3: zoom steps, keys, comparison modes

/** Both sides landed and decoded: a 400×200 Before and a 200×300 After, in 424×324 stages. */
async function decodedPair(t) {
  await t.land(imageSide('old', 'k1'), imageSide('new', 'k2'));
  const [a, b] = t.qa('img');
  t.loaded(a, 400, 200);
  t.loaded(b, 200, 300);
  return [a, b];
}

test('zoom: − / + step ×2 from the scale on screen, the level shows it, pixels go square above 100%', async (tc) => {
  const t = await mount(tc);
  const [a] = await decodedPair(t);
  const level = t.q('.ip-zoom-level');
  assert.equal(level.textContent, '100%', 'Fit of images that fit: 100%');
  const [out, inn] = t.qa('.ip-zoom-step');
  assert.deepEqual([out.title, inn.title], ['Zoom out (-)', 'Zoom in (+)']);
  inn.click();
  assert.deepEqual([a.style.width, level.textContent], ['800px', '200%']);
  assert.ok(t.q('.ip').classList.contains('is-pixelated'), 'image-rendering: pixelated above 100%');
  assert.deepEqual(t.qa('.ip-zoom-btn').map((b) => b.getAttribute('aria-pressed')), ['false', 'false'], 'neither Fit nor 100%');
  out.click();
  out.click();
  assert.deepEqual([a.style.width, level.textContent], ['200px', '50%']);
  assert.equal(t.q('.ip').classList.contains('is-pixelated'), false);
  for (let i = 0; i < 5; i++) out.click();
  assert.equal(level.textContent, '12.5%');
  assert.equal(out.disabled, true, 'the smallest step');
  t.dispose();
});

test('zoom: at Fit below 12.5% (a huge image), - zooms nothing and + goes to 12.5%', async (tc) => {
  const t = await mount(tc);
  await t.land(imageSide('old', 'k1'), imageSide('new', 'k2'));
  const [a, b] = t.qa('img');
  t.loaded(a, 40000, 20000); // Fit: 400×200, 1%
  t.loaded(b, 16, 16);
  const level = t.q('.ip-zoom-level');
  const [out] = t.qa('.ip-zoom-step');
  assert.deepEqual([a.style.width, level.textContent, out.disabled], ['400px', '1%', true]);
  const e = t.dom.key('-', {}, t.dom.doc.body);
  assert.equal(e.defaultPrevented, true);
  assert.deepEqual([a.style.width, level.textContent], ['400px', '1%'], 'still Fit: - never zooms in');
  assert.equal(t.qa('.ip-zoom-btn')[0].getAttribute('aria-pressed'), 'true');
  t.dom.key('+', {}, t.dom.doc.body);
  assert.deepEqual([a.style.width, level.textContent], ['5000px', '12.5%']);
  t.dispose();
});

test('keys: + - 0 1 zoom and m cycles the mode while a picture is shown; not in a text field, not with ⌘', async (tc) => {
  const t = await mount(tc);
  const [a] = await decodedPair(t);
  const press = (key, mods) => t.dom.key(key, mods, t.dom.doc.body);
  let e = press('+');
  assert.equal(e.defaultPrevented, true);
  assert.equal(a.style.width, '800px');
  press('-');
  press('-');
  assert.equal(a.style.width, '200px');
  press('1');
  assert.equal(a.style.width, '400px');
  press('=');
  press('0');
  assert.equal(a.style.width, '400px', 'Fit (it fits)');
  e = press('+', { metaKey: true });
  assert.equal(e.defaultPrevented, false, '⌘+ is the page zoom (the View menu)');
  assert.equal(a.style.width, '400px');
  press('m');
  assert.ok(t.q('.ip-compare'), 'm: side by side -> swipe');
  assert.equal(t.q('.ip-compare').dataset.mode, 'swipe');
  const input = t.dom.doc.createElement('input');
  input.type = 'text';
  t.dom.doc.body.append(input);
  input.focus();
  press('m', {});
  t.dom.key('m', {}, input);
  assert.equal(t.q('.ip-compare').dataset.mode, 'swipe', 'typing in a field changes nothing');
  t.dispose();
});

test('keys: no image keys without a picture (a non-image, a too-large side); n / p still belong to the diff', async (tc) => {
  const t = await mount(tc);
  await t.land(other('old', 'too-large', { size: 34 * MB, soft: true, limit: 'size', max: 20 * MB }), other('new', 'unsupported', { format: 'heic' }));
  assert.equal(t.dom.key('+', {}, t.dom.doc.body).defaultPrevented, false);
  assert.equal(t.dom.key('m', {}, t.dom.doc.body).defaultPrevented, false);
  t.dispose();
});

test('modes: offered only for two images; swipe, onion skin and difference overlay them in one frame; the choice is kept', async (tc) => {
  const t = await mount(tc);
  await t.land(imageSide('old', 'k1'), other('new', 'absent', { size: null, key: null, format: null, dims: null }));
  assert.equal(t.q('.ip-modes').hidden, true, 'an added image: nothing to compare');
  t.store.actions.loadImagePreview(t.spec);
  await decodedPair(t);
  const modes = t.q('.ip-modes');
  assert.equal(modes.hidden, false);
  assert.deepEqual(t.texts('.ip-mode-btn'), ['Side by side', 'Swipe', 'Onion skin', 'Difference']);
  assert.deepEqual(t.qa('.ip-mode-btn').filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.mode), ['side-by-side']);

  t.qa('.ip-mode-btn')[1].click(); // swipe
  assert.equal(t.q('.ip-panes'), null, 'the panes make way for the frame');
  const stage = t.q('.ip-compare-stage');
  stage.clientWidth = 424;
  stage.clientHeight = 324;
  t.store.set({ imagePreview: { ...t.store.state.imagePreview } }); // the ResizeObserver is a stub here: a redraw sizes the frame
  const frame = t.q('.ip-frame');
  const [before, after, handle] = frame.children;
  assert.deepEqual([before.dataset.side, after.dataset.side, handle.getAttribute('role')], ['old', 'new', 'slider']);
  assert.deepEqual([frame.style.width, frame.style.height], ['400px', '300px'], 'the larger width and height at Fit');
  assert.deepEqual([before.style.width, after.style.width, after.style.height], ['400px', '200px', '300px'], 'one scale, top-left aligned');
  assert.equal(after.style.clipPath, 'inset(0 0 0 200px)', 'After right of the divider at 50%');
  assert.deepEqual(t.texts('.ip-compare-label'), ['Before', 'After']);
  assert.deepEqual(t.texts('.ip-compare-side'), ['Before: PNG · 400×200 · 100 KB', 'After: PNG · 200×300 · 100 KB']);
  handle.focus();
  t.dom.key('ArrowRight', {}, handle);
  assert.equal(handle.getAttribute('aria-valuenow'), '55');
  assert.equal(after.style.clipPath, 'inset(0 0 0 220px)');
  t.dom.key('End', {}, handle);
  t.dom.key('ArrowRight', {}, handle);
  assert.equal(handle.getAttribute('aria-valuenow'), '100', 'kept within the frame');
  assert.equal(t.storage.getItem('pl.imageMode'), '"swipe"', 'one preference for the app');

  t.qa('.ip-mode-btn')[2].click(); // onion skin
  const range = t.q('.ip-onion-range');
  assert.equal(after.style.clipPath, '', 'no clip outside swipe');
  assert.equal(after.style.opacity, '0.5');
  range.value = '20';
  t.dom.dispatch(range, 'input');
  assert.equal(after.style.opacity, '0.2');
  assert.equal(frame.children.length, 2, 'no divider');

  t.qa('.ip-mode-btn')[3].click(); // difference
  assert.ok(frame.classList.contains('is-difference'));
  assert.equal(after.style.opacity, '');
  assert.match(t.q('.ip-compare-controls').textContent, /identical pixels are black/);

  t.qa('.ip-mode-btn')[0].click(); // back side by side: the same <img>s, no overlay styles left
  const imgs = t.qa('img');
  assert.deepEqual(imgs, [before, after]);
  assert.deepEqual(t.texts('.ip-pane-title'), ['Before', 'After']);
  t.dispose();
});

test('modes: the stored mode applies to the next file; a decode failure falls back to side by side', async (tc) => {
  const storage = H.memoryStorage();
  storage.setItem('pl.imageMode', '"difference"');
  const t = await mount(tc, { storage });
  await decodedPair(t);
  assert.equal(t.q('.ip-compare').dataset.mode, 'difference');
  t.dom.dispatch(t.q('.ip-frame').children[1], 'error');
  assert.equal(t.q('.ip-compare'), null);
  assert.deepEqual(t.texts('.ip-state'), ['Couldn\'t decode this image']);
  assert.equal(t.q('.ip-modes').hidden, true);
  t.dispose();
});

// ------------------------------------------------------------------ I3: text-backed images, conflicts

const svgText = () => {
  const f = { oldPath: 'icon.svg', newPath: 'icon.svg', isBinary: false, oldMode: '100644', newMode: '100644', hunks: [{ header: '@@ -1 +1 @@', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [{ type: 'del', text: '<svg/>', oldNo: 1 }, { type: 'add', text: '<svg width="2"/>', newNo: 1 }] }] };
  return { file: f, sections: [f], fingerprint: null, truncated: false, conflict: null };
};

test('an SVG with a text diff: the preview by default, Preview | Text in the header, the choice kept for the app', async (tc) => {
  const t = await mount(tc, { file: 'icon.svg', diff: svgText() });
  assert.ok(t.q('.ip'), 'the rendered preview first');
  assert.equal(t.q('.dv-row'), null);
  const [pv, tx] = t.qa('.dv-view-btn');
  assert.deepEqual([pv.textContent, tx.textContent, pv.getAttribute('aria-pressed')], ['Preview', 'Text', 'true']);
  const svg = (side) => imageSide(side, `s-${side}`, { format: 'svg', mime: 'image/svg+xml', dims: null });
  await t.land(svg('old'), svg('new'));
  assert.equal(t.qa('img').length, 2);
  tx.click();
  assert.equal(t.q('.ip'), null);
  assert.ok(t.qa('.dv-row').length > 0, 'the text diff\'s rows');
  const textBtn = t.qa('.dv-view-btn').find((b) => b.dataset.view === 'text');
  assert.equal(textBtn.getAttribute('aria-pressed'), 'true');
  assert.equal(t.dom.doc.activeElement, textBtn, 'focus stays on the switch');
  assert.equal(t.storage.getItem('pl.imageView'), '"text"');
  assert.equal(t.dom.key('+', {}, t.dom.doc.body).defaultPrevented, false, 'no image keys while the text shows');
  t.dispose();

  const again = await mount(tc, { file: 'icon.svg', diff: svgText(), storage: t.storage });
  assert.equal(again.q('.ip'), null, 'Text remembered');
  again.qa('.dv-view-btn').find((b) => b.dataset.view === 'preview').click();
  assert.ok(again.q('.ip'));
  assert.equal(again.storage.getItem('pl.imageView'), '"preview"');
  again.dispose();
});

test('a binary diff has no Preview | Text switch; a text file none either', async (tc) => {
  const t = await mount(tc);
  assert.equal(t.q('.dv-view-toggle'), null);
  t.dispose();
  const txt = svgText();
  txt.file.oldPath = 'a.txt';
  txt.file.newPath = 'a.txt';
  const u = await mount(tc, { file: 'a.txt', diff: txt });
  assert.equal(u.q('.dv-view-toggle'), null);
  assert.equal(u.q('.ip'), null);
  u.dispose();
});

test('a conflicted binary image: Base, Ours and Theirs panes from the index stages, no delta, no modes', async (tc) => {
  let n = 0;
  H.setLocalStorage(H.memoryStorage());
  const urlApi = { createObjectURL: () => `blob:file:///c${++n}`, revokeObjectURL() {} };
  const st = { ...H.status({ oid: 'a'.repeat(40), branch: 'main' }), state: 'merging', merge: { head: SHA, name: 'feature/x' } };
  const { win, api, store } = await H.loadedStore(H.repoData({ commits: [H.commit('a'.repeat(40))], status: st }), { urlApi });
  const { root } = mountView(tc, win, store);
  store.actions.openDiff({ kind: 'workdir', file: 'a.png', staged: false, untracked: false });
  api.take('workdirDiffView').resolve({ file: null, sections: [], fingerprint: null, truncated: false, conflict: { path: 'a.png', hunks: [], isBinary: true } });
  await H.flush();
  const texts = (sel) => root.querySelectorAll(sel).map((x) => x.textContent);
  assert.match(texts('.dv-banner')[0], /^Conflicted image/);
  for (const w of ['base', 'old', 'new']) {
    api.take('workdirImageSide', (c) => c.args[2] === w).resolve({ ...imageSide(w, `k-${w}`), source: 'index' });
  }
  await H.flush();
  const op = win.PLOp.conflictSides(store.state.status, store.state.refsBySha);
  assert.deepEqual(texts('.ip-pane-title'), ['Base', `Ours (${op.ours})`, `Theirs (${op.theirs})`]);
  assert.equal(root.querySelectorAll('img').length, 3);
  assert.deepEqual(texts('.ip-fact'), [], 'no before / after delta');
  assert.equal(root.querySelector('.ip-modes').hidden, true);
  assert.deepEqual(texts('.ip-meta'), ['PNG · 512×512 · 100 KB', 'PNG · 512×512 · 100 KB', 'PNG · 512×512 · 100 KB'], 'no "Index" source on every pane');
  assert.ok(root.querySelector('.ip-panes').classList.contains('is-conflict'));
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
