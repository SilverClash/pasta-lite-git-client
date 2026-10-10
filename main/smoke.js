'use strict';
// The --smoke harness (dev/test tool, CONTRIBUTING.md "Smoke run"): loaded only by main.js, and only
// when parseArgs allowed --smoke (never in a packaged build). It renders a view, optionally runs
// a script in it, captures the window to a PNG, prints one JSON line and exits 0 / 1.
//
// Headless mode is one object: `ui` below replaces the desktop UI port everywhere (no dialog, no
// focus, a transparent window that never takes a click), so the app code has no smoke branches.
//
// Smoke mode runs as its own primary instance: it never takes the single-instance lock and uses a
// throwaway userData folder (removed on exit), so it works even while the app is open. A `--smoke`
// forwarded to an already running instance (second-instance argv) is ignored.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { app, nativeImage } = require('electron');
const { logger } = require('../src/log');

const log = logger.child('main');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Evaluated in the page: the rendered view's data once it reports ready, else null.
const PROBE = `(() => {
  const b = document.body;
  if (!b || b.dataset.ready !== '1') return null;
  const toast = document.getElementById('toast');
  return {
    view: b.dataset.view,
    title: document.title,
    stats: window.PL && typeof window.PL.probe === 'function' ? window.PL.probe() : null,
    recent: document.querySelectorAll('#recent-list li').length,
    toast: toast && !toast.hidden && toast.dataset.level !== 'info' ? toast.textContent : null,
    notice: toast && !toast.hidden && toast.dataset.level === 'info' ? toast.textContent : null,
  };
})()`;

/**
 * Chromium keeps writing into userData (Local State, Preferences, ...) until its processes are
 * gone, after any exit hook of ours. So a detached watcher (this binary as plain Node) waits for
 * this process to exit, then removes `dir`. It also cleans up after a crash.
 */
function removeWhenGone(dir) {
  const script = `
    const fs = require('node:fs');
    const [pid, dir] = [Number(process.argv[1]), process.argv[2]];
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const t = setInterval(() => {
      if (alive()) return;
      clearInterval(t);
      setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }, 1000);
    }, 200);`;
  try {
    spawn(process.execPath, ['-e', script, String(process.pid), dir], {
      detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    }).unref();
  } catch (err) {
    log.warn('could not start the userData cleaner', { err });
  }
}

/**
 * Clone in a smoke run (scripts/smoke-clone.js): PL_SMOKE_CLONE_PARENT=<dir> is the parent folder
 * (seeded as clone.json's last parent, and the answer to "Choose where to clone"). Without it the
 * dialog answers nothing and there is no parent: a smoke run never clones into the real home
 * folder. The source is typed like any URL (the script serves its fixtures over local HTTP).
 */
const smokeCloneParent = () => (process.env.PL_SMOKE_CLONE_PARENT ? path.resolve(process.env.PL_SMOKE_CLONE_PARENT) : null);

/** PL_SMOKE_TABS=<repo>[:<repo>...] (path.delimiter-separated): extra tabs for the smoke run. */
const smokeExtraTabs = () => (process.env.PL_SMOKE_TABS || '').split(path.delimiter).filter(Boolean).map((p) => path.resolve(p));

/**
 * @param {{
 *   options: {repo: string|null, out: string|null},
 *   window: () => Electron.BrowserWindow|null, createWindow: () => Electron.BrowserWindow, layout: () => void,
 *   tabs: object, pageTabs: () => object[], stripHeight: number,
 *   restoreTabs: () => Promise<void>, opening: () => object, quitGuard: {run(): Promise<string>},
 *   runner: {running(): {op: string}[]}, diagnosticsText: () => Promise<string>,
 *   git: () => {gitVersion: string|null, gitPath: string|null},
 * }} deps  functions for what main creates later (the window, the opening use cases).
 */
module.exports = function createSmoke(deps) {
  const smoke = deps.options;
  const win = () => deps.window();
  let done = false;

  /** The UI port in headless mode: nothing asks, nothing takes the focus, errors are only logged. */
  const ui = {
    interactive: false,
    confirm: async () => false, // never reached: the callers refuse or go on without asking
    focus: () => {},
    showError: () => {},
    /**
     * A hidden window never paints its tab views (capturePage has no surface for them), so the
     * window is shown without focus, fully transparent and ignoring the mouse: nothing appears or
     * takes a click, and the page still never gets focus (the watcher check needs that).
     */
    present(w) {
      w.setOpacity(0);
      w.setIgnoreMouseEvents(true);
      w.once('ready-to-show', () => w.showInactive());
    },
  };

  /**
   * Keep smoke runs away from the user's recent list and from a running instance.
   * PL_SMOKE_USERDATA=<dir> keeps userData (localStorage drafts, recent list, tabs) across smoke runs.
   */
  function setupUserData() {
    const keep = process.env.PL_SMOKE_USERDATA;
    const smokeUserData = keep ? path.resolve(keep) : fs.mkdtempSync(path.join(os.tmpdir(), 'pl-smoke-'));
    fs.mkdirSync(smokeUserData, { recursive: true });
    app.setPath('userData', smokeUserData);
    if (!keep) removeWhenGone(smokeUserData);
    const parent = smokeCloneParent();
    if (parent) fs.writeFileSync(path.join(smokeUserData, 'clone.json'), `${JSON.stringify({ lastParent: parent })}\n`);
  }

  /** The clone service's "Choose where to clone", answered from PL_SMOKE_CLONE_PARENT. */
  const clone = { pickFolder: async () => smokeCloneParent() };

  /** Logs and crash dumps under userData, so the real folders stay clean. */
  function setupLogPaths() {
    const ud = app.getPath('userData');
    app.setAppLogsPath(path.join(ud, 'logs'));
    app.setPath('crashDumps', path.join(ud, 'Crashpad'));
  }

  /** Print the smoke result (once) and exit. */
  function exit(obj, code) {
    if (done) return;
    done = true;
    process.stdout.write(`${JSON.stringify(obj)}\n`);
    // app.exit skips before-quit, so cancel running ops here (smoke mode never asks). userData is
    // removed by removeWhenGone once this process is gone. app.exit skips will-quit too: flush here.
    deps.quitGuard.run().catch((err) => log.error('error', { err })).finally(() => {
      log.info('smoke run done', { ok: !!obj.ok, code });
      logger.flushSync();
      app.exit(code);
    });
  }

  /**
   * PL_SMOKE_WATCH=1 (smoke with a repo only): check the file watcher end to end. Main creates an
   * untracked file in the repo (not a runner write, so nothing else refreshes: the smoke window is
   * never focused), waits for the page's unstaged count to go up, removes the file and waits for it
   * to go back. Resolves {ok, added, removed} (ms each, null when it timed out) or {ok: false, error}.
   */
  async function smokeWatchCheck(s) {
    const root = s.repo.root;
    const unstaged = async () => {
      const p = await s.webContents.executeJavaScript(PROBE);
      return p && p.stats ? p.stats.unstaged : null;
    };
    const waitFor = async (want, ms) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (done || s.closed) return null;
        if ((await unstaged()) === want) return Date.now() - t0;
        await delay(100);
      }
      return null;
    };
    await delay(500); // let the watches settle (FSEvents / inotify setup)
    const before = await unstaged();
    if (typeof before !== 'number') return { ok: false, error: 'no unstaged count in the probe' };
    const file = path.join(root, `pl-smoke-watch-${process.pid}`);
    const addAndRemove = async () => {
      try {
        fs.writeFileSync(file, 'pasta-lite smoke: file watcher check\n', { flag: 'wx' });
        return await waitFor(before + 1, 8000);
      } finally {
        fs.rmSync(file, { force: true });
      }
    };
    const added = await addAndRemove();
    const removed = added === null ? null : await waitFor(before, 8000);
    return { ok: added !== null && removed !== null, before, added, removed };
  }

  /**
   * The whole window as one image: the strip (the window's own contents, full size) with the active
   * tab's view drawn over it below the strip height. Both captures are at the display's scale.
   */
  async function captureWindow() {
    const w = win();
    const strip = await w.webContents.capturePage().catch((e) => { throw new Error(`strip: ${e.message}`); });
    const a = deps.tabs.active();
    if (!a) return strip;
    const view = await a.webContents.capturePage().catch((e) => { throw new Error(`view: ${e.message}`); });
    // Pixel size of a capture (getSize() may be in DIPs; the bitmap is in pixels).
    const pixels = (img) => {
      const size = img.getSize();
      const bitmap = img.toBitmap();
      const k = Math.sqrt(bitmap.length / 4 / (size.width * size.height)) || 1;
      return { bitmap, width: Math.round(size.width * k), height: Math.round(size.height * k) };
    };
    const s = pixels(strip);
    const v = pixels(view);
    const top = Math.round(deps.stripHeight * (s.width / w.getContentSize()[0]));
    const out = Buffer.from(s.bitmap);
    const rowBytes = Math.min(v.width, s.width) * 4;
    for (let y = 0; y < v.height && top + y < s.height; y++) {
      v.bitmap.copy(out, (top + y) * s.width * 4, y * v.width * 4, y * v.width * 4 + rowBytes);
    }
    return nativeImage.createFromBitmap(out, { width: s.width, height: s.height });
  }

  /**
   * --smoke: render a view, capture it to a PNG, print one JSON line, exit 0 / 1. With tabs: the
   * saved tabs are restored (only a kept PL_SMOKE_USERDATA has any), the repo opens as a CLI path
   * does, PL_SMOKE_TABS adds background tabs, and the script runs in the active tab's page. The
   * capture is the whole window, strip included.
   */
  async function run() {
    const timer = setTimeout(() => exit({ ok: false, error: 'timeout after 30 s' }, 1), 30000);
    try {
      if (!smoke.out) throw new Error('usage: --smoke [<repo>] <out.png>');
      deps.createWindow();
      await new Promise((resolve) => win().webContents.once('did-finish-load', resolve));
      await deps.restoreTabs();
      const opening = deps.opening();
      if (smoke.repo) await opening.openExternal(smoke.repo);
      for (const extra of smokeExtraTabs()) await opening.openBackgroundTab(extra);
      const s = deps.tabs.active();
      await s.loaded;
      const want = s.repo ? 'repo' : 'welcome';
      let probe = null;
      while (!probe || probe.view !== want) {
        await delay(100);
        if (done) return; // timed out meanwhile
        if (!win() || win().isDestroyed() || s.closed) throw new Error('window closed');
        probe = await s.webContents.executeJavaScript(PROBE);
      }
      // Optional scripted interaction (smoke only; dev/test tool): PL_SMOKE_JS=<file> is evaluated in
      // the active tab's page and awaited (its value is reported as `script`); PL_SMOKE_STRIP_JS the
      // same in the tab strip, after it (`strip`); PL_SMOKE_SIZE=WxH resizes first.
      const size = /^(\d+)x(\d+)$/.exec(process.env.PL_SMOKE_SIZE || '');
      if (size) {
        win().setContentSize(Number(size[1]), Number(size[2]));
        deps.layout();
      }
      let watchCheck;
      if (process.env.PL_SMOKE_WATCH === '1' && smoke.repo && s.repo) {
        watchCheck = await smokeWatchCheck(s);
        if (done) return;
      }
      let script;
      if (process.env.PL_SMOKE_JS) {
        script = await s.webContents.executeJavaScript(fs.readFileSync(process.env.PL_SMOKE_JS, 'utf8'));
        if (done) return;
      }
      let strip;
      if (process.env.PL_SMOKE_STRIP_JS) {
        strip = await win().webContents.executeJavaScript(fs.readFileSync(process.env.PL_SMOKE_STRIP_JS, 'utf8'));
        if (done) return;
      }
      // PL_SMOKE_DIAG=1: write the Copy Diagnostics text to <out.png>.diagnostics.txt.
      let diagnostics;
      if (process.env.PL_SMOKE_DIAG === '1') {
        diagnostics = `${smoke.out}.diagnostics.txt`;
        fs.writeFileSync(diagnostics, await deps.diagnosticsText());
      }
      // PL_SMOKE_CRASH=1: crash the active tab's renderer (after PL_SMOKE_JS) and report the
      // render-process-gone the app saw instead of capturing: {crash: {reason, exitCode}}.
      if (process.env.PL_SMOKE_CRASH === '1') {
        const target = (deps.tabs.active() || s).webContents;
        const gone = new Promise((resolve) => target.once('render-process-gone', (_e, d) => resolve(d)));
        target.forcefullyCrashRenderer();
        const d = await Promise.race([gone, delay(5000).then(() => null)]);
        await delay(100); // app's render-process-gone handler runs after the webContents one
        exit({ ok: !!d, script, crash: d && { reason: d.reason, exitCode: d.exitCode }, logDir: logger.dir, diagnostics }, d ? 0 : 1);
        return;
      }
      // PL_SMOKE_QUIT=1: no capture; quit the way the user would (app.quit: before-quit, quit guard).
      if (process.env.PL_SMOKE_QUIT === '1') {
        done = true;
        const running = deps.runner.running().map((r) => r.op);
        process.stdout.write(`${JSON.stringify({ ok: true, quit: true, script, running })}\n`);
        app.quit();
        return;
      }
      await delay(300); // let the last frame paint
      if (done) return;
      const shown = deps.tabs.active() || s; // the script may have switched tabs
      probe = { ...probe, ...(await shown.webContents.executeJavaScript(PROBE)) };
      const image = await captureWindow();
      fs.writeFileSync(smoke.out, image.toPNG());
      const ok = !probe.toast && (!watchCheck || watchCheck.ok);
      const { gitVersion, gitPath } = deps.git();
      exit({
        ok, ...probe, script, strip, tabs: deps.pageTabs(), watch: watchCheck, gitVersion, gitPath, png: smoke.out,
        size: image.getSize(), logDir: logger.dir, diagnostics,
      }, ok ? 0 : 1);
    } catch (err) {
      exit({ ok: false, error: err.message, kind: err.kind || null }, 1);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * tabs:probe, smoke runs only (routeSender lets a view call it then; the channel table checks
   * the tab id): the rendered state of any tab's page.
   */
  const probe = (_ctx, id) => deps.tabs.get(id).webContents.executeJavaScript(PROBE);

  return { ui, setupUserData, setupLogPaths, exit, run, clone, handlers: { 'tabs:probe': probe } };
};
