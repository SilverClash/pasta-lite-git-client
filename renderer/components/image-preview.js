'use strict';
// Image preview of the diff view (plain script; exposes window.PLImagePreview). docs/plans/image-preview.md §6.2, §6.5, §6.6.
//
// A sub-view the diff view owns, like components/diff-staging.js: for a diff that PLImage.wantsPreview
// (a binary file, a text-backed image shown as Preview, a conflicted image), diff-view.js's layoutBody
// puts attach(d, binaryText) in place of the "Binary file — no preview" message or the rows. It shows
// state.imagePreview (renderer/store.js), which the store loads and reloads itself, and subscribes to
// that key on its own, so a side landing redraws only the preview, never the diff's rows.
//
// Layout: a summary bar (size change, dimensions / format changes, the comparison mode, zoom), then
// the Before and After panes side by side (one pane, "Added" / "Deleted", when a side doesn't exist;
// Base, Ours and Theirs for a conflict), each an image on a checkerboard (transparency) with its
// metadata below, or a message for a side that can't be shown (too large + Load preview, Git LFS not
// available locally, unsupported format, decode error, op error). When no side has anything to show
// (a binary non-image) the binary message stays. Pure rules: PLImage (components/image-model.js).
//
// Comparison modes (PLImage.MODES; Before and After both decoded images, not a conflict): side by
// side, or both images in one frame at one scale, top-left aligned — swipe (After over Before up to
// a divider: drag it, or focus it and use the arrow keys, 5% a step), onion skin (After over Before
// at the slider's opacity) and difference (After blended with `mix-blend-mode: difference`:
// identical pixels are black; pure CSS). The mode is one preference for the app
// (Components.util.storage), the zoom, swipe and opacity positions are kept from file to file.
//
// Zoom: Fit shrinks an image into its pane (never enlarges); 100% is one image pixel per CSS pixel;
// zoom in / out step ×2 / ÷2 (12.5%–3200%), from Fit starting at the scale on screen. Above 100% the
// pixels are drawn square (image-rendering: pixelated). At any zoom but Fit the panes scroll together.
// Keys (keys.js VIEW_KEYS 'image', run by onKey from the diff view's keydown while a picture is
// shown): + / - zoom, 0 Fit, 1 100%, m the next comparison mode.
//
// Untrusted content: paths, labels and messages go through textContent; the only URLs ever set on an
// <img> are the blob: URLs the store's PLImageCache made (an SVG renders only as an <img>, Chromium's
// secure static mode: no script, no external loads, never inlined into the DOM).
(function () {
  const { el, util } = window.Components;
  const Img = window.PLImage;
  const keys = () => window.Components.actions; // matchViewKey / viewKeyHint (keys.js), loaded before the components
  const PAD = 12; // px around an image in its stage (.ip-stage padding)
  const DEFAULT_SIZE = { width: 300, height: 150 }; // CSS's default object size: an SVG without width, height or viewBox
  const MODE_KEY = 'pl.imageMode'; // the comparison mode: one preference for the app
  const SWIPE_STEP = 5; // percent per arrow key on the swipe divider
  const SIDE_TITLES = { old: 'Before', new: 'After' };

  /**
   * create({store}) -> {attach(d, binaryText) -> element, detach(), onKey(keydown) -> boolean,
   * dispose()}. attach: show the preview of diff `d` (binaryText: the message when there's nothing
   * to preview); detach: the body shows something else (no redraws meanwhile); onKey: run an image
   * key (true: handled, default prevented).
   */
  function create({ store }) {
    const root = el('div', 'ip');
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', 'Image preview');
    let spec = null; // the attached diff's spec, null while detached
    let binaryText = '';
    let zoom = 'fit'; // kept from file to file, like the mode and the swipe / opacity positions
    let mode = Img.modeOf(util.storage.get(MODE_KEY, null));
    let swipe = 50; // percent of the frame's width shown as Before (left of the divider)
    let onion = 50; // After's opacity, percent
    let shownScale = 1; // the scale of the most shrunk image on screen (Fit's zoom steps start there)
    let overlay = null; // the comparison frame's last PLImage.overlaySize
    let imgs = new Map(); // 'old' | 'new' | 'base' + url -> <img> (kept across redraws, so a redraw never reloads one)
    let panes = new Map(); // 'old' | 'new' | 'base' -> {node, title, stage, meta}: kept too (scroll and focus survive a redraw)
    let compareEls = null; // the comparison view's parts, made once per file
    let decoded = new Map(); // url -> {width, height} once it loaded
    let failed = new Set(); // urls that didn't decode
    const echoes = new WeakMap(); // stage -> {left, top} a mirrored write moved it to (its scroll event is ours, not the user's)
    let dragging = false; // the swipe divider follows the pointer

    const preview = () => {
      const p = store.state.imagePreview;
      return p && spec && Img.sameTarget(p.spec, spec) ? p : null;
    };
    const slotOf = (p, which) => (p ? p[which] || null : null);
    const failedOf = (slot) => !!(slot && slot.url && failed.has(slot.url));
    const decodedOf = (slot) => (slot && slot.url ? decoded.get(slot.url) || null : null);
    const failures = (p) => ({ old: failedOf(slotOf(p, 'old')), new: failedOf(slotOf(p, 'new')), base: failedOf(slotOf(p, 'base')) });
    const pathOf = (which) => (which === 'old' && spec.orig ? spec.orig : spec.file);
    const naturalOf = (url) => {
      const d = decoded.get(url);
      return d && d.width > 0 && d.height > 0 ? d : DEFAULT_SIZE;
    };
    const hint = (title, id) => {
      const k = keys().viewKeyHint(id);
      return k ? `${title} (${k})` : title;
    };

    // ------------------------------------------------------------ images

    /** The <img> of side `which` showing `url` (one per side: both sides may have the same bytes). */
    function imgFor(which, url, alt) {
      const key = `${which} ${url}`;
      let img = imgs.get(key);
      if (!img) {
        if (!/^blob:/.test(url)) return null; // only the store's own object URLs
        img = el('img', 'ip-img');
        img.decoding = 'async';
        img.draggable = false;
        img.dataset.side = which;
        img.addEventListener('load', () => {
          decoded.set(url, { width: img.naturalWidth || 0, height: img.naturalHeight || 0 });
          if (imgs.get(key) === img) render();
        });
        img.addEventListener('error', () => {
          failed.add(url);
          if (imgs.get(key) === img) render();
        });
        img.src = url;
        img.dataset.url = url;
        imgs.set(key, img);
      }
      img.alt = alt;
      return img;
    }

    const px = (n) => `${n}px`;

    /** Size the comparison frame and its two images; returns the scale, or null until both decoded. */
    function sizeOverlay() {
      const c = compareEls;
      const [a, b] = [c.frame.children[0], c.frame.children[1]];
      if (!a || !b || !decoded.has(a.dataset.url) || !decoded.has(b.dataset.url)) return null;
      const box = { width: c.stage.clientWidth - 2 * PAD, height: c.stage.clientHeight - 2 * PAD };
      overlay = Img.overlaySize(zoom, naturalOf(a.dataset.url), naturalOf(b.dataset.url), box);
      c.frame.style.width = px(overlay.frame.width);
      c.frame.style.height = px(overlay.frame.height);
      for (const [img, size] of [[a, overlay.old], [b, overlay.new]]) {
        img.style.width = px(size.width);
        img.style.height = px(size.height);
        img.classList.add('is-sized');
      }
      c.frame.classList.add('is-sized');
      applyMode();
      return overlay.scale;
    }

    /** Size every shown image for the zoom (Fit needs its stage's size; a stage without one waits for the resize). */
    function sizeImages() {
      let scale = null;
      if (compareEls && compareEls.node.parentNode === root) scale = sizeOverlay();
      else {
        for (const p of panes.values()) {
          const img = p.node.parentNode ? p.stage.firstChild : null;
          if (!img || img.tagName !== 'IMG' || !decoded.has(img.dataset.url)) continue;
          const natural = naturalOf(img.dataset.url);
          const box = { width: p.stage.clientWidth - 2 * PAD, height: p.stage.clientHeight - 2 * PAD };
          const size = Img.scaledSize(zoom, natural, box);
          if (!size) continue;
          img.style.width = px(size.width);
          img.style.height = px(size.height);
          img.classList.add('is-sized');
          const s = size.width / natural.width;
          scale = scale === null ? s : Math.min(scale, s);
        }
      }
      if (scale !== null) shownScale = scale;
      const shown = zoom === 'fit' ? shownScale : Number(zoom);
      root.classList.toggle('is-pixelated', Img.pixelated(shown));
      levelEl.textContent = Img.zoomText(shown);
    }

    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { if (spec) sizeImages(); }) : null;
    if (ro) ro.observe(root);

    /**
     * At any zoom but Fit the panes scroll together (the same image region side by side). Scroll
     * events come a frame later, so a pane we moved fires one too: it is recognised by the position
     * the write left it at (clamped when its image is smaller) and not mirrored back, which would
     * pull the pane the user drives back into the smaller one's range.
     */
    function mirrorScroll(e) {
      const from = e.target;
      const echo = echoes.get(from);
      if (echo) {
        echoes.delete(from);
        if (echo.left === from.scrollLeft && echo.top === from.scrollTop) return;
      }
      if (zoom === 'fit') return;
      for (const p of panes.values()) {
        const to = p.stage;
        if (to === from || !p.node.parentNode) continue;
        const was = { left: to.scrollLeft, top: to.scrollTop };
        to.scrollLeft = from.scrollLeft;
        to.scrollTop = from.scrollTop;
        // A write that moved nothing fires no event of its own (an earlier write's echo may still be due).
        if (to.scrollLeft !== was.left || to.scrollTop !== was.top) echoes.set(to, { left: to.scrollLeft, top: to.scrollTop });
      }
    }

    // ------------------------------------------------------------ summary bar

    // The summary bar and the panes' row are made once and updated in place, so a side landing
    // never moves a focused button or resets a pane's scroll position.
    const summaryEl = el('div', 'ip-summary');
    const factsEl = el('div', 'ip-facts');
    const toolsEl = el('div', 'ip-tools');
    const modeEl = el('div', 'seg ip-modes');
    const zoomEl = el('div', 'seg ip-zoom');
    const levelEl = el('span', 'ip-zoom-level');
    const panesEl = el('div', 'ip-panes');
    modeEl.setAttribute('role', 'group');
    modeEl.setAttribute('aria-label', 'Comparison mode');
    modeEl.title = hint('Comparison mode', 'cycleMode');
    zoomEl.setAttribute('role', 'group');
    zoomEl.setAttribute('aria-label', 'Zoom');
    toolsEl.append(modeEl, levelEl, zoomEl);
    summaryEl.append(factsEl, toolsEl);

    for (const m of Img.MODES) {
      const b = util.button('seg-btn ip-mode-btn', m.label, m.title, () => setMode(m.id));
      b.dataset.mode = m.id;
      modeEl.append(b);
    }
    const zoomButton = (value, text, title) => {
      const b = util.button('seg-btn ip-zoom-btn', text, title, () => setZoom(value));
      b.dataset.zoom = String(value);
      return b;
    };
    const stepButton = (dir, text, title) => {
      const b = util.button('seg-btn ip-zoom-step', text, title, () => zoomBy(dir));
      b.setAttribute('aria-label', dir > 0 ? 'Zoom in' : 'Zoom out');
      return b;
    };
    zoomEl.append(
      stepButton(-1, '−', hint('Zoom out', 'zoomOut')),
      zoomButton('fit', 'Fit', hint('Shrink large images to fit', 'zoomFit')),
      zoomButton(1, '100%', hint('Actual size: one image pixel per screen point', 'zoomActual')),
      stepButton(1, '+', hint('Zoom in', 'zoomIn')),
    );
    levelEl.setAttribute('aria-live', 'polite');

    function syncZoom() {
      root.classList.toggle('is-actual', zoom !== 'fit');
      for (const b of zoomEl.querySelectorAll('.ip-zoom-btn')) b.setAttribute('aria-pressed', String(b.dataset.zoom === String(zoom)));
      const [out, , , inn] = zoomEl.children;
      const shown = zoom === 'fit' ? shownScale : Number(zoom);
      out.disabled = shown <= Img.ZOOM_STEPS[0] + 1e-9;
      inn.disabled = shown >= Img.ZOOM_STEPS[Img.ZOOM_STEPS.length - 1] - 1e-9;
    }

    function setZoom(value) {
      if (zoom === value) return;
      zoom = value;
      sizeImages();
      syncZoom();
    }

    const zoomBy = (dir) => setZoom(Img.zoomStep(zoom, dir, zoom === 'fit' ? shownScale : undefined));

    function syncModes(available) {
      modeEl.hidden = !available;
      for (const b of modeEl.querySelectorAll('.ip-mode-btn')) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
    }

    function setMode(id) {
      const next = Img.modeOf(id);
      if (next === mode) return;
      mode = next;
      util.storage.set(MODE_KEY, mode);
      render();
    }

    function summary(p, fails) {
      const old = slotOf(p, 'old');
      const neu = slotOf(p, 'new');
      const both = !(p && p.conflict) && old && neu && old.side && neu.side && !old.error && !neu.error;
      const d = both ? Img.delta(old.side, neu.side, { oldDecoded: decodedOf(old), newDecoded: decodedOf(neu) }) : null;
      factsEl.replaceChildren(...Img.deltaParts(d).map((part) => {
        const mod = part.dir > 0 ? ' ip-grew' : part.dir < 0 ? ' ip-shrank' : '';
        return el('span', `ip-fact ip-fact-${part.kind}${mod}`, part.text);
      }));
      const pictures = ['old', 'new', 'base'].some((w) => slotOf(p, w) && slotOf(p, w).url);
      zoomEl.hidden = !pictures;
      levelEl.hidden = !pictures;
      syncModes(Img.canCompare(p, fails));
      syncZoom();
    }

    // ------------------------------------------------------------ panes (side by side)

    function stateEl(st, which) {
      const box = el('div', `ip-state${st.kind === 'error' ? ' ip-error' : ''}${st.kind === 'loading' ? ' ip-loading' : ''}`);
      box.append(el('div', 'ip-state-text', st.kind === 'loading' ? 'Loading image…' : st.text));
      if (st.load) {
        const b = el('button', 'dv-act ip-load', 'Load preview');
        b.type = 'button';
        b.title = 'Read the whole file and show it';
        b.addEventListener('click', () => store.actions.loadImagePreview(store.state.imagePreview && store.state.imagePreview.spec, { force: true, side: which }));
        box.append(b);
      }
      return box;
    }

    function paneEls(which) {
      let p = panes.get(which);
      if (!p) {
        p = {
          node: el('section', 'ip-pane'), title: el('div', 'ip-pane-title'), stage: el('div', 'ip-stage'), meta: el('div', 'ip-meta'),
          state: null, stateKey: null, // the message shown and what it says (kind, text, Load preview)
        };
        p.node.dataset.side = which;
        p.stage.addEventListener('scroll', mirrorScroll, { passive: true });
        p.node.append(p.title, p.stage, p.meta);
        panes.set(which, p);
      }
      return p;
    }

    /** The metadata line of a side (and the mismatch note), as elements; `label` goes first ('Before: …'). */
    function metaParts(slot, which, { conflict = false, label = null } = {}) {
      const info = Img.meta(slot && slot.side, { decoded: decodedOf(slot), workdir: spec.kind === 'workdir' && !conflict, path: pathOf(which) });
      const text = el('span', 'ip-meta-text', [label, info.parts.join(' · ')].filter(Boolean).join(': '));
      const parts = [text];
      if (info.note) parts.push(el('span', 'ip-mismatch', info.note));
      return parts;
    }

    /** An <img> back in a pane or out of the frame: none of the comparison modes' styles. */
    function plain(img) {
      img.style.clipPath = '';
      img.style.opacity = '';
    }

    function pane(p, { which, title }) {
      const slot = slotOf(p, which);
      const els = paneEls(which);
      els.node.setAttribute('aria-label', title);
      els.title.textContent = title;
      const conflict = !!(p && p.conflict);
      const st = Img.paneState(slot, { failed: failedOf(slot), conflict });
      const img = st.kind === 'image' ? imgFor(which, slot.url, Img.altText(title, pathOf(which), slot.side, decodedOf(slot))) : null;
      if (img) {
        plain(img);
        els.stage.tabIndex = 0; // arrows / PgUp / PgDn pan an image larger than its pane
        els.stage.setAttribute('aria-label', `${title} image`);
        if (els.stage.firstChild !== img) els.stage.replaceChildren(img);
      } else {
        els.stage.tabIndex = -1;
        els.stage.removeAttribute('aria-label');
        // Made again only when it says something else: a redraw (the other side landing) keeps a focused
        // Load preview button, and "Loading image…" its 150 ms delay.
        const msg = st.kind === 'image' ? { kind: 'loading' } : st;
        const key = JSON.stringify([msg.kind, msg.text || '', !!msg.load]);
        if (els.stateKey !== key) {
          els.state = stateEl(msg, which);
          els.stateKey = key;
        }
        if (els.stage.firstChild !== els.state) els.stage.replaceChildren(els.state);
      }
      els.meta.replaceChildren(...metaParts(slot, which, { conflict }));
      return els.node;
    }

    function panesView(p, lay) {
      const nodes = lay.panes.map((x) => pane(p, x));
      const shown = [...panesEl.childNodes];
      if (shown.length !== nodes.length || nodes.some((n, i) => shown[i] !== n)) panesEl.replaceChildren(...nodes);
      panesEl.classList.toggle('is-single', nodes.length === 1);
      panesEl.classList.toggle('is-conflict', !!(p && p.conflict));
      return panesEl;
    }

    // ------------------------------------------------------------ comparison modes

    function makeCompare() {
      const c = {
        node: el('div', 'ip-compare'),
        controls: el('div', 'ip-compare-controls'),
        stage: el('div', 'ip-stage ip-compare-stage'),
        frame: el('div', 'ip-frame'),
        handle: el('div', 'ip-swipe-handle'),
        range: el('input', 'ip-onion-range'),
        meta: el('div', 'ip-meta ip-compare-meta'),
        sets: {}, // mode -> its controls row
      };
      c.stage.tabIndex = 0;
      c.stage.setAttribute('aria-label', 'Before and after image');
      c.stage.append(c.frame);
      c.node.append(c.controls, c.stage, c.meta);
      c.handle.tabIndex = 0;
      c.handle.setAttribute('role', 'slider');
      c.handle.setAttribute('aria-label', 'Swipe divider: Before on the left, After on the right');
      c.handle.setAttribute('aria-valuemin', '0');
      c.handle.setAttribute('aria-valuemax', '100');
      c.handle.addEventListener('keydown', (e) => {
        const to = { ArrowLeft: swipe - SWIPE_STEP, ArrowDown: swipe - SWIPE_STEP, ArrowRight: swipe + SWIPE_STEP, ArrowUp: swipe + SWIPE_STEP, Home: 0, End: 100 }[e.key];
        if (to === undefined || e.metaKey || e.ctrlKey || e.altKey) return;
        e.preventDefault();
        setSwipe(to);
      });
      c.range.type = 'range';
      c.range.min = '0';
      c.range.max = '100';
      c.range.setAttribute('aria-label', 'After opacity');
      c.range.addEventListener('input', () => {
        onion = Img.clampPct(Number(c.range.value));
        applyMode();
      });
      const swipeTo = (e) => {
        const r = c.frame.getBoundingClientRect();
        if (r.width > 0) setSwipe(((e.clientX - r.left) / r.width) * 100);
      };
      c.frame.addEventListener('pointerdown', (e) => {
        if (mode !== 'swipe' || e.button !== 0) return;
        e.preventDefault();
        dragging = true;
        if (typeof c.frame.setPointerCapture === 'function' && e.pointerId !== undefined) c.frame.setPointerCapture(e.pointerId);
        c.handle.focus({ preventScroll: true });
        swipeTo(e);
      });
      c.frame.addEventListener('pointermove', (e) => { if (dragging) swipeTo(e); });
      const stop = () => { dragging = false; };
      c.frame.addEventListener('pointerup', stop);
      c.frame.addEventListener('pointercancel', stop);
      c.stage.addEventListener('scroll', mirrorScroll, { passive: true });
      return c;
    }

    function setSwipe(v) {
      swipe = Math.round(Img.clampPct(v) * 10) / 10;
      applyMode();
    }

    /** The mode's styles on the frame's After image, divider and slider. */
    function applyMode() {
      const c = compareEls;
      if (!c) return;
      const after = c.frame.children[1];
      if (!after) return;
      after.style.clipPath = mode === 'swipe' && overlay ? `inset(0 0 0 ${px(Math.round((swipe / 100) * overlay.frame.width))})` : '';
      after.style.opacity = mode === 'onion' ? String(onion / 100) : '';
      c.handle.style.left = `${swipe}%`;
      c.handle.setAttribute('aria-valuenow', String(swipe));
      c.handle.setAttribute('aria-valuetext', `${Math.round(swipe)}% Before`);
      c.range.value = String(onion);
    }

    /** The controls row of the mode: made once per mode, so a redraw never moves the focused slider. */
    function controlsFor(c) {
      if (c.sets[mode]) return c.sets[mode];
      const label = (text) => el('span', 'ip-compare-label', text);
      const hintEl = (text) => el('span', 'ip-compare-hint', text);
      if (mode === 'swipe') c.sets[mode] = [label('Before'), hintEl('Drag the divider, or focus it and use ← →'), label('After')];
      else if (mode === 'onion') c.sets[mode] = [label('Before'), c.range, label('After')];
      else c.sets[mode] = [hintEl('Difference: identical pixels are black, changed ones light up')];
      return c.sets[mode];
    }

    function compareView(p) {
      const c = compareEls || (compareEls = makeCompare());
      c.node.dataset.mode = mode;
      const imgOf = (which) => imgFor(which, p[which].url, Img.altText(SIDE_TITLES[which], pathOf(which), p[which].side, decodedOf(p[which])));
      const kids = [imgOf('old'), imgOf('new'), ...(mode === 'swipe' ? [c.handle] : [])];
      const shown = [...c.frame.children];
      if (shown.length !== kids.length || kids.some((k, i) => shown[i] !== k)) c.frame.replaceChildren(...kids);
      for (const m of Img.MODES) c.frame.classList.toggle(`is-${m.id}`, m.id === mode);
      const controls = controlsFor(c);
      const had = [...c.controls.children];
      if (had.length !== controls.length || controls.some((k, i) => had[i] !== k)) c.controls.replaceChildren(...controls);
      c.meta.replaceChildren(sideMeta(p, 'old'), sideMeta(p, 'new'));
      applyMode();
      return c.node;
    }

    /** 'Before: PNG · 512×512 · 100 KB' under the frame. */
    function sideMeta(p, which) {
      const box = el('span', 'ip-compare-side');
      box.dataset.side = which;
      box.append(...metaParts(p[which], which, { label: SIDE_TITLES[which] }));
      return box;
    }

    // ------------------------------------------------------------ render

    /** {ours, theirs} display names of a conflict's sides (op-model.js), or null. */
    function conflictNames() {
      const Op = window.PLOp;
      return Op && typeof Op.conflictSides === 'function' ? Op.conflictSides(store.state.status, store.state.refsBySha) : null;
    }

    function render() {
      if (!spec) return;
      const p = preview();
      const fails = failures(p);
      const lay = Img.layout(p, fails, { names: p && p.conflict ? conflictNames() : null });
      if (lay.fallback) {
        const m = el('div', 'dv-message dv-message-binary');
        m.append(el('div', 'dv-message-text', lay.note ? `${binaryText}\n${lay.note}` : binaryText));
        root.replaceChildren(m);
        return;
      }
      const compare = mode !== 'side-by-side' && Img.canCompare(p, fails);
      summary(p, fails);
      const body = compare ? compareView(p) : panesView(p, lay);
      if (root.children.length !== 2 || root.firstChild !== summaryEl || summaryEl.nextSibling !== body) root.replaceChildren(summaryEl, body);
      sizeImages();
      syncZoom();
    }

    function attach(d, text) {
      if (!spec || !Img.sameTarget(spec, d.spec)) {
        imgs = new Map();
        panes = new Map();
        compareEls = null;
        overlay = null;
        decoded = new Map();
        failed = new Set();
      }
      spec = d.spec;
      binaryText = text || '';
      render();
      return root;
    }

    function detach() {
      spec = null;
      dragging = false;
    }

    /**
     * An image key (keys.js VIEW_KEYS 'image') while a picture is shown: + / - zoom, 0 Fit, 1 100%,
     * m the next comparison mode (when Before and After can be compared). true: handled.
     */
    function onKey(e) {
      if (!spec || !root.isConnected || root.firstChild !== summaryEl || zoomEl.hidden) return false;
      const k = keys().matchViewKey(e, 'image');
      if (!k) return false;
      if (k.id === 'cycleMode') {
        if (modeEl.hidden) return false;
        e.preventDefault();
        if (!e.repeat) setMode(Img.nextMode(mode));
        return true;
      }
      e.preventDefault();
      if (k.id === 'zoomIn') zoomBy(1);
      else if (k.id === 'zoomOut') zoomBy(-1);
      else setZoom(k.id === 'zoomFit' ? 'fit' : 1);
      return true;
    }

    const unsub = store.subscribe(['imagePreview'], render);

    function dispose() {
      unsub();
      if (ro) ro.disconnect();
      detach();
      imgs = new Map();
      panes = new Map();
      compareEls = null;
      root.replaceChildren();
    }

    return { attach, detach, onKey, dispose };
  }

  window.PLImagePreview = { create };
})();
