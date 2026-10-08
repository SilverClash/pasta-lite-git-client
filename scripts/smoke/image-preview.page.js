// The image preview, checked in the real app (docs/plans/image-preview.md §10.4): a PL_SMOKE_JS page
// script for the --smoke harness (main/smoke.js), evaluated in the repository page, whose value is
// the run's `script` result: {ok, failures, steps}. scripts/smoke-image-preview.js runs it on the demo
// repository (scripts/demo-repo.js) and on a conflicted merge; on its own:
//   PL_SMOKE_JS=scripts/smoke/image-preview.page.js npx electron . --smoke <demo repo> out.png
// It opens each image of images/ the way a click does, waits for the <img>s to load and checks what
// Chromium drew (natural sizes, computed styles), the comparison modes and keys, Preview | Text, the
// local Git LFS cache, HEIC / TIFF / PSD through the OS thumbnailer (macOS: QuickLook), and — in a
// repository with a merge in progress — a conflict's three panes.
(async () => {
  const s = window.PL.store;
  // The smoke window is shown transparent and inactive, so Chromium clamps its timers to a second;
  // waiting yields through a MessageChannel instead (a task, not a timer).
  const tick = () => new Promise((r) => {
    const c = new MessageChannel();
    c.port1.onmessage = () => r();
    c.port2.postMessage(0);
  });
  const until = async (f, ms = 8000) => {
    for (const t = performance.now(); performance.now() - t < ms; await tick()) {
      const v = f();
      if (v) return v;
    }
    return null;
  };
  const sleep = (ms) => until(() => false, ms);
  const failures = [];
  const steps = {};
  const check = (ok, what) => { if (!ok) failures.push(what); };
  const q = (sel) => document.querySelector(sel);
  const qa = (sel) => [...document.querySelectorAll(sel)];
  const texts = (sel) => qa(sel).map((x) => x.textContent);
  const press = async (key) => {
    document.body.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    await sleep(80);
  };
  const shaOf = (subject) => (s.state.commits.find((c) => c.subject === subject) || {}).hash;

  /** Open `spec`'s diff, wait for the preview's sides and every <img>'s load; a snapshot of what shows. */
  async function open(spec) {
    const t0 = performance.now();
    const lap = [];
    s.actions.select(spec.kind === 'workdir' ? { kind: 'wip' } : { kind: 'commit', sha: spec.sha });
    await sleep(200);
    s.actions.openDiff(spec);
    await until(() => s.state.diff && !s.state.diff.loading);
    lap.push(Math.round(performance.now() - t0));
    await until(() => !s.state.imagePreview || ['old', 'new', 'base'].every((w) => !s.state.imagePreview[w] || !s.state.imagePreview[w].loading));
    lap.push(Math.round(performance.now() - t0));
    await sleep(150);
    // Loaded = decoded far enough for its natural size (img.decode() never settles in the smoke
    // window, which is shown transparent and inactive, so it would never paint a frame).
    const imgs = qa('.ip-img');
    await until(() => imgs.every((i) => i.complete), 4000);
    lap.push(Math.round(performance.now() - t0));
    const decoded = imgs.map((i) => (i.complete ? (i.naturalWidth > 0 ? 'ok' : 'broken') : 'loading'));
    await sleep(100);
    return {
      imgs: imgs.map((i, n) => ({ decode: decoded[n], natural: [i.naturalWidth, i.naturalHeight], css: [i.style.width, i.style.height], blob: i.src.startsWith('blob:') })),
      titles: texts('.ip-pane-title'),
      meta: texts('.ip-meta'),
      states: texts('.ip-state-text'),
      facts: texts('.ip-fact'),
      message: q('.dv-message') && q('.dv-message').textContent,
      badges: texts('.dv-badge'),
      ms: lap, // diff loaded, sides landed, images loaded
    };
  }
  const allDecoded = (snap, n) => snap.imgs.length === n && snap.imgs.every((i) => i.decode === 'ok' && i.natural[0] > 0 && i.blob);

  if (s.state.status && s.state.status.state === 'merging') {
    // ---------------------------------------------------------------- a conflicted binary image
    const snap = await open({ kind: 'workdir', file: 'images/logo.png', staged: false, untracked: false });
    steps.conflict = snap;
    check(allDecoded(snap, 3), 'conflict: base, ours and theirs decode');
    check(snap.titles[0] === 'Base' && /^Ours \(/.test(snap.titles[1]) && /^Theirs \(/.test(snap.titles[2]), `conflict: pane titles ${snap.titles}`);
    check(/^Conflicted image/.test(texts('.dv-banner').join(' ')), 'conflict: the banner');
    return { ok: !failures.length, failures, steps };
  }

  const head = shaOf('feat(images): new logo and icon');
  const first = shaOf('feat(images): logo, icons and photos');
  check(head && first, 'the demo repository has the image commits');

  // ---------------------------------------------------------------- an unstaged animated WebP
  let snap = await open({ kind: 'workdir', file: 'images/hero.webp', staged: false, untracked: false });
  steps.hero = snap;
  check(allDecoded(snap, 2), 'hero.webp: both sides decode');
  check(snap.meta.some((m) => m.includes('WebP · animated')), 'hero.webp: animated WebP');
  check(snap.facts.length > 0, 'hero.webp: the size change');

  // ---------------------------------------------------------------- a commit's PNG: zoom, keys, modes
  snap = await open({ kind: 'commit', sha: head, file: 'images/logo.png' });
  steps.logo = snap;
  check(allDecoded(snap, 2), 'logo.png: both sides decode');
  check(snap.badges.includes('image'), 'logo.png: the image badge');
  const img = q('.ip-img');
  await press('+');
  await press('+');
  steps.zoom = { level: q('.ip-zoom-level').textContent, width: img.style.width, rendering: getComputedStyle(img).imageRendering };
  check(steps.zoom.level === '400%' && steps.zoom.width === '256px', `zoom: + + is 400% (${steps.zoom.level}, ${steps.zoom.width})`);
  check(steps.zoom.rendering === 'pixelated', `zoom: pixelated above 100% (${steps.zoom.rendering})`);
  await press('0');
  check(q('.ip-zoom-level').textContent === '100%', 'zoom: 0 is Fit');
  steps.modes = [];
  for (const want of ['swipe', 'onion', 'difference', 'side-by-side']) {
    await press('m');
    const c = q('.ip-compare');
    const frame = q('.ip-frame');
    const after = frame && frame.querySelector('.ip-img[data-side="new"]');
    const st = after ? getComputedStyle(after) : null;
    steps.modes.push({
      mode: c ? c.dataset.mode : 'side-by-side', frame: frame && [frame.style.width, frame.style.height],
      clip: st && st.clipPath, opacity: st && st.opacity, blend: st && st.mixBlendMode,
    });
    check((c ? c.dataset.mode : 'side-by-side') === want, `m: ${want}`);
    if (want === 'swipe' && frame) { // drag the divider to a quarter of the frame
      const r = frame.getBoundingClientRect();
      const at = { clientX: r.left + r.width / 4, clientY: r.top + r.height / 2, button: 0, pointerId: 1, bubbles: true };
      frame.dispatchEvent(new PointerEvent('pointerdown', at));
      frame.dispatchEvent(new PointerEvent('pointerup', at));
      steps.swipeDrag = { now: q('.ip-swipe-handle').getAttribute('aria-valuenow'), clip: getComputedStyle(after).clipPath };
      check(steps.swipeDrag.now === '25', `swipe: dragged to 25% (${steps.swipeDrag.now})`);
    }
  }
  const [swipe, onion, diff] = steps.modes;
  check(swipe.clip && swipe.clip.startsWith('inset('), `swipe: After clipped (${swipe.clip})`);
  check(onion.opacity === '0.5', `onion: After at 50% (${onion.opacity})`);
  check(diff.blend === 'difference', `difference: mix-blend-mode (${diff.blend})`);
  check(!!(swipe.frame && swipe.frame[0] === '64px'), `the frame of two 64×64 images (${swipe.frame})`);

  // ---------------------------------------------------------------- an SVG text diff: Preview | Text
  snap = await open({ kind: 'commit', sha: head, file: 'images/icon.svg' });
  steps.icon = snap;
  check(!!q('.dv-view-toggle'), 'icon.svg: the Preview | Text switch');
  check(allDecoded(snap, 2), 'icon.svg: both sides render (as <img>)');
  qa('.dv-view-btn').find((b) => b.dataset.view === 'text').click();
  await sleep(150);
  steps.iconText = { rows: qa('.dv-row').length, preview: !!q('.ip') };
  check(steps.iconText.rows > 0 && !steps.iconText.preview, 'icon.svg: Text shows the rows');
  qa('.dv-view-btn').find((b) => b.dataset.view === 'preview').click();
  await sleep(150);
  check(!!q('.ip'), 'icon.svg: back to the preview');

  // ---------------------------------------------------------------- one side each (added files)
  const added = async (file) => open({ kind: 'commit', sha: first, file: `images/${file}` });
  snap = await added('lfs-cached.png');
  steps.lfsCached = snap;
  check(allDecoded(snap, 1) && snap.meta.some((m) => m.includes('LFS ')), 'lfs-cached.png: the object from the local LFS cache');
  snap = await added('lfs-missing.png');
  steps.lfsMissing = snap;
  check(snap.states.some((t) => /Stored in Git LFS \(.+\) — not available locally/.test(t)), 'lfs-missing.png: not available locally');
  // HEIC, TIFF (two pages: the first one shows) and PSD through the OS thumbnailer: macOS's QuickLook
  // here; on Windows it depends on the installed codecs; elsewhere "preview not supported".
  const mac = /Mac/.test(navigator.platform);
  const win = /Win/.test(navigator.platform);
  for (const [file, label, size] of [['scan.heic', 'HEIC', '64×64'], ['scan.tiff', 'TIFF', '96×64'], ['layers.psd', 'PSD', '64×64']]) {
    snap = await added(file);
    steps[file] = snap;
    const thumb = allDecoded(snap, 1) && snap.imgs[0].natural.join('×') === size
      && snap.meta.some((m) => m.includes(`${label} · ${size}`) && /Preview by (macOS|Windows)/.test(m));
    const unsupported = snap.states.includes(`${label} — preview not supported`);
    if (mac) check(thumb && snap.meta.some((m) => m.includes('Preview by macOS')), `${file}: a thumbnail by macOS (${snap.meta} ${snap.states})`);
    else if (win) check(thumb || unsupported, `${file}: a thumbnail by Windows, or not supported`);
    else check(unsupported, `${file}: not supported`);
  }
  await open({ kind: 'commit', sha: first, file: 'images/scan.tiff' });
  const tiffImg = q('.ip-img');
  if (mac && tiffImg) { // the first page (an orange to purple gradient), not the second (teal)
    const c = document.createElement('canvas');
    c.width = 96;
    c.height = 64;
    const g = c.getContext('2d');
    g.drawImage(tiffImg, 0, 0);
    steps.tiffPixel = [...g.getImageData(48, 2, 1, 1).data];
    check(steps.tiffPixel[0] > 200 && steps.tiffPixel[2] < 100, `scan.tiff: the first page (${steps.tiffPixel})`);
  }
  snap = await added('photo.jpg');
  steps.photo = snap;
  check(allDecoded(snap, 1) && snap.imgs[0].natural.join('×') === '40×80', `photo.jpg: EXIF rotation applied (${snap.imgs.map((i) => i.natural)})`);
  snap = await added('mislabeled.png');
  steps.mislabeled = snap;
  check(allDecoded(snap, 1) && snap.meta.some((m) => m.includes('content is JPEG, named .png')), 'mislabeled.png: the mismatch note');
  snap = await added('sprite.gif');
  steps.sprite = snap;
  check(allDecoded(snap, 1) && snap.meta.some((m) => m.includes('GIF · animated')), 'sprite.gif: animated GIF');
  snap = await added('badge.avif');
  steps.avif = snap;
  check(allDecoded(snap, 1), 'badge.avif: AVIF decodes');

  // Back to the logo for the screenshot (side by side).
  await open({ kind: 'commit', sha: head, file: 'images/logo.png' });
  return { ok: !failures.length, failures, steps };
})();
