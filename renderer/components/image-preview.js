'use strict';
// Image preview of the diff view (plain script; exposes window.PLImagePreview). docs/plans/image-preview.md §6.2.
//
// A sub-view the diff view owns, like components/diff-staging.js: for a diff that PLImage.wantsPreview
// (a binary file), diff-view.js's layoutBody puts attach(d, binaryText) in place of the "Binary file —
// no preview" message. It shows state.imagePreview (renderer/store.js), which the store loads and
// reloads itself, and subscribes to that key on its own, so a side landing redraws only the preview,
// never the diff's rows.
//
// Layout: a summary bar (size change, dimensions / format changes, Fit | 100%), then the Before and
// After panes side by side (one pane, "Added" / "Deleted", when a side doesn't exist), each an image
// on a checkerboard (transparency) with its metadata below, or a message for a side that can't be
// shown (too large + Load preview, Git LFS, unsupported format, decode error, op error). When neither
// side has anything to show (a binary non-image) the binary message stays. Pure rules: PLImage
// (components/image-model.js).
//
// Untrusted content: paths, labels and messages go through textContent; the only URLs ever set on an
// <img> are the blob: URLs the store's PLImageCache made (an SVG renders only as an <img>, Chromium's
// secure static mode: no script, no external loads, never inlined into the DOM). Zoom: Fit shrinks an
// image into its pane (never enlarges); 100% is one image pixel per CSS pixel, both panes scrolled together.
(function () {
  const { el } = window.Components;
  const Img = window.PLImage;
  const PAD = 12; // px around an image in its stage (.ip-stage padding)
  const DEFAULT_SIZE = { width: 300, height: 150 }; // CSS's default object size: an SVG without width, height or viewBox

  /**
   * create({store}) -> {attach(d, binaryText) -> element, detach(), dispose()}. attach: show the
   * preview of diff `d` (binaryText: the binary message, when there's nothing to preview); detach:
   * the body shows something else (no redraws meanwhile).
   */
  function create({ store }) {
    const root = el('div', 'ip');
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', 'Image preview');
    let spec = null; // the attached diff's spec, null while detached
    let binaryText = '';
    let zoom = 'fit'; // kept from file to file
    let imgs = new Map(); // 'old' | 'new' + url -> <img> (kept across redraws, so a redraw never reloads one)
    let panes = new Map(); // 'old' | 'new' -> {node, title, stage, meta}: kept too (scroll and focus survive a redraw)
    let decoded = new Map(); // url -> {width, height} once it loaded
    let failed = new Set(); // urls that didn't decode
    let syncing = false; // a scroll being mirrored to the other pane

    const preview = () => {
      const p = store.state.imagePreview;
      return p && spec && Img.sameTarget(p.spec, spec) ? p : null;
    };
    const slotOf = (p, which) => (p ? p[which] : null);
    const failedOf = (slot) => !!(slot && slot.url && failed.has(slot.url));
    const decodedOf = (slot) => (slot && slot.url ? decoded.get(slot.url) || null : null);
    const pathOf = (which) => (which === 'old' && spec.orig ? spec.orig : spec.file);

    // ------------------------------------------------------------ images

    /** The <img> of side `which` showing `url` (one per pane: both sides may have the same bytes). */
    function imgFor(which, url, alt) {
      const key = `${which} ${url}`;
      let img = imgs.get(key);
      if (!img) {
        if (!/^blob:/.test(url)) return null; // only the store's own object URLs
        img = el('img', 'ip-img');
        img.decoding = 'async';
        img.draggable = false;
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

    /** Size every shown image for the zoom (Fit needs its stage's size; a stage without one waits for the resize). */
    function sizeImages() {
      for (const stage of root.querySelectorAll('.ip-stage')) {
        const img = stage.querySelector('img');
        const measured = img && decoded.get(img.dataset.url);
        if (!measured) continue;
        const natural = measured.width > 0 && measured.height > 0 ? measured : DEFAULT_SIZE;
        const box = { width: stage.clientWidth - 2 * PAD, height: stage.clientHeight - 2 * PAD };
        const size = Img.scaledSize(zoom, natural, box);
        if (!size) continue;
        img.style.width = `${size.width}px`;
        img.style.height = `${size.height}px`;
        img.classList.add('is-sized');
      }
    }

    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { if (spec) sizeImages(); }) : null;
    if (ro) ro.observe(root);

    /** At 100% the panes scroll together (the same image region side by side). */
    function mirrorScroll(e) {
      if (syncing || zoom === 'fit') return;
      const from = e.target;
      for (const stage of root.querySelectorAll('.ip-stage')) {
        if (stage === from) continue;
        syncing = true;
        stage.scrollLeft = from.scrollLeft;
        stage.scrollTop = from.scrollTop;
        syncing = false;
      }
    }

    // ------------------------------------------------------------ parts

    // The summary bar and the panes' row are made once and updated in place, so a side landing
    // never moves a focused button or resets a pane's scroll position.
    const summaryEl = el('div', 'ip-summary');
    const factsEl = el('div', 'ip-facts');
    const zoomEl = el('div', 'ip-zoom');
    const panesEl = el('div', 'ip-panes');
    zoomEl.setAttribute('role', 'group');
    zoomEl.setAttribute('aria-label', 'Zoom');
    summaryEl.append(factsEl, zoomEl);

    function zoomButton(value, text, title) {
      const b = el('button', 'ip-zoom-btn', text);
      b.type = 'button';
      b.title = title;
      b.dataset.zoom = String(value);
      b.addEventListener('click', () => setZoom(value));
      return b;
    }
    zoomEl.append(zoomButton('fit', 'Fit', 'Shrink large images to fit'), zoomButton(1, '100%', 'Actual size: one image pixel per screen point'));

    function syncZoom() {
      root.classList.toggle('is-actual', zoom !== 'fit');
      for (const b of zoomEl.querySelectorAll('.ip-zoom-btn')) b.setAttribute('aria-pressed', String(b.dataset.zoom === String(zoom)));
    }

    function setZoom(value) {
      if (zoom === value) return;
      zoom = value;
      syncZoom();
      sizeImages();
    }

    function summary(p) {
      const old = slotOf(p, 'old');
      const neu = slotOf(p, 'new');
      const both = old && neu && old.side && neu.side && !old.error && !neu.error;
      const d = both ? Img.delta(old.side, neu.side, { oldDecoded: decodedOf(old), newDecoded: decodedOf(neu) }) : null;
      factsEl.replaceChildren(...Img.deltaParts(d).map((part) => {
        const mod = part.dir > 0 ? ' ip-grew' : part.dir < 0 ? ' ip-shrank' : '';
        return el('span', `ip-fact ip-fact-${part.kind}${mod}`, part.text);
      }));
      zoomEl.hidden = ![old, neu].some((s) => s && s.url);
      syncZoom();
    }

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
        p = { node: el('section', 'ip-pane'), title: el('div', 'ip-pane-title'), stage: el('div', 'ip-stage'), meta: el('div', 'ip-meta') };
        p.node.dataset.side = which;
        p.stage.addEventListener('scroll', mirrorScroll, { passive: true });
        p.node.append(p.title, p.stage, p.meta);
        panes.set(which, p);
      }
      return p;
    }

    function pane(p, { which, title }) {
      const slot = slotOf(p, which);
      const els = paneEls(which);
      els.node.setAttribute('aria-label', title);
      els.title.textContent = title;
      const st = Img.paneState(slot, { failed: failedOf(slot) });
      const img = st.kind === 'image' ? imgFor(which, slot.url, Img.altText(title, pathOf(which), slot.side, decodedOf(slot))) : null;
      if (img) {
        els.stage.tabIndex = 0; // arrows / PgUp / PgDn pan an image larger than its pane
        els.stage.setAttribute('aria-label', `${title} image`);
        if (els.stage.firstChild !== img) els.stage.replaceChildren(img);
      } else {
        els.stage.tabIndex = -1;
        els.stage.removeAttribute('aria-label');
        els.stage.replaceChildren(stateEl(st.kind === 'image' ? { kind: 'loading' } : st, which));
      }
      const info = Img.meta(slot && slot.side, { decoded: decodedOf(slot), workdir: spec.kind === 'workdir', path: pathOf(which) });
      const text = el('span', 'ip-meta-text', info.parts.join(' · '));
      els.meta.replaceChildren(text);
      if (info.note) els.meta.append(el('span', 'ip-mismatch', info.note));
      return els.node;
    }

    // ------------------------------------------------------------ render

    function render() {
      if (!spec) return;
      const p = preview();
      const old = slotOf(p, 'old');
      const neu = slotOf(p, 'new');
      const lay = Img.layout(p, { old: failedOf(old), new: failedOf(neu) });
      if (lay.fallback) {
        const m = el('div', 'dv-message dv-message-binary');
        m.append(el('div', 'dv-message-text', lay.note ? `${binaryText}\n${lay.note}` : binaryText));
        root.replaceChildren(m);
        return;
      }
      summary(p);
      const nodes = lay.panes.map((x) => pane(p, x));
      const shown = [...panesEl.childNodes];
      if (shown.length !== nodes.length || nodes.some((n, i) => shown[i] !== n)) panesEl.replaceChildren(...nodes);
      panesEl.classList.toggle('is-single', nodes.length === 1);
      if (root.firstChild !== summaryEl || summaryEl.nextSibling !== panesEl) root.replaceChildren(summaryEl, panesEl);
      sizeImages();
    }

    function attach(d, text) {
      if (!spec || !Img.sameTarget(spec, d.spec)) {
        imgs = new Map();
        panes = new Map();
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
    }

    const unsub = store.subscribe(['imagePreview'], render);

    function dispose() {
      unsub();
      if (ro) ro.disconnect();
      detach();
      imgs = new Map();
      panes = new Map();
      root.replaceChildren();
    }

    return { attach, detach, dispose };
  }

  window.PLImagePreview = { create };
})();
