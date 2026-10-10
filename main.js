'use strict';
// Electron main process: the composition root. It reads the command line, creates the stores,
// the ops runner, the UI port and the parts below, wires them together and handles the app
// lifecycle (start, quit, crashes, second launches).
//
// - main/window.js          the window (its own web contents is the tab strip, renderer/tabs.html)
// - main/tabs-controller.js the repository tabs: one WebContentsView (renderer/index.html) and one
//                           session (src/tab-session.js) per tab
// - main/ipc.js             the IPC boundary, registered from src/ipc-contract.js's channel table
// - main/menu.js            the application menu
// - main/diagnostics-ui.js  Help → Show Logs / Show Crash Reports / Copy Diagnostics, the crash prompt
// - main/smoke.js           the --smoke harness (dev only; never loaded in a packaged build)
// - src/repo-opening.js     every open of a repository; src/repo-trust.js the Trust and Open policy
// - src/clone-service.js    Clone Repository… (src/clone.js, src/clone-cleanup.js; clone.json)
//
// Security boundary: the renderer never passes a repo path. Main holds each tab's repo and
// injects it into every operation (main/ipc.js), so a compromised renderer can only run the
// fixed ops in src/ops.js (which validate their arguments) against the repo the user opened in
// that tab.
const { app, ipcMain, session, crashReporter, dialog, clipboard, shell, nativeImage } = require('electron');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const ops = require('./src/ops');
const git = require('./src/git');
const { findGit, describeGitFailure } = require('./src/gitcheck');
const { createRecentStore, createTrustStore, createClonePrefs } = require('./src/recent');
const { createCleanup, keepListed } = require('./src/clone-cleanup');
const { createCloneService } = require('./src/clone-service');
const { setGitBinary, killChildren } = require('./src/exec');
const { parseArgs: parseArgv } = require('./src/cli-args');
const { createTabsStore } = require('./src/tabs-store');
const { createWatcher } = require('./src/watcher');
const { createQuitGuard, createQuitFlow, confirmWith } = require('./src/quit-guard');
const { logger } = require('./src/log');
const { redactString } = require('./src/redact');
const { createRendererLogSink } = require('./src/renderer-log');
const { crashReporterOptions } = require('./src/diagnostics');
const { createRepoTrust } = require('./src/repo-trust');
const { createRepoOpening, shouldForgetRecent } = require('./src/repo-opening');
const { createRecentView } = require('./src/recent-view');
const { openTerminal } = require('./src/terminal');
const { createOsThumbnailer } = require('./src/os-thumbnail');
const { EVENTS } = require('./src/ipc-contract');
const { createWindowHost, APP_NAME, APP_ID, DATA_DIR_NAME, ICON, STRIP_H, SECURE_WEB_PREFS } = require('./main/window');
const { createTabsController } = require('./main/tabs-controller');
const { createSenderContext, registerChannels, createHandlers } = require('./main/ipc');
const { createAppMenu } = require('./main/menu');
const { createDiagnosticsUi, appPath, logsDir, crashDir } = require('./main/diagnostics-ui');

const isMac = process.platform === 'darwin';
const INDEX_HTML = path.join(__dirname, 'renderer', 'index.html');
const TABS_HTML = path.join(__dirname, 'renderer', 'tabs.html');
// Loaded with loadURL(pathToFileURL(...)): loadFile doesn't escape '%', so a folder named 'pct%41'
// loaded 'pctA'. The sender check compares decoded paths, not URL strings (ipc-contract isIndexUrl).
const INDEX_URL = pathToFileURL(INDEX_HTML).href;
const TABS_URL = pathToFileURL(TABS_HTML).href;

// Logging: one local JSON-lines file, configured in setupLogging() below. Scopes:
const log = logger.child('main');
const ipcLog = logger.child('ipc');
const quitLog = logger.child('quit');
const crashLog = logger.child('crash');
const watchLog = logger.child('watcher');
const tabLog = logger.child('tabs');
const cloneLog = logger.child('clone');

// ---------------------------------------------------------------- command line

// Smoke mode (and with it PL_SMOKE_JS / PL_SMOKE_USERDATA) is a dev tool: packaged builds ignore --smoke.
const parseArgs = (argv, cwd = process.cwd()) => parseArgv(argv, { cwd, defaultApp: !!process.defaultApp, allowSmoke: !app.isPackaged });

const args = parseArgs(process.argv);
// {repo, out} for --smoke; beyond loading the harness below, `smoke` only gates what a smoke page
// may do (the page's --pl-smoke flag, the smoke IPC channels in routeSender). Everything else
// asks the UI port.
const smoke = args.smoke;

// ---------------------------------------------------------------- state

let gitVersion = null;
let gitPath = null; // the git binary every spawn uses (gitcheck.findGit → exec.setGitBinary)
let recent = null; // store; created when app is ready (needs userData). Also the "started" flag
let trustedRepos = null; // repos opened despite config that runs commands (trusted.json)
let tabsStore = null; // the open tabs (tabs.json), restored at launch
let cloneService = null; // Clone Repository… (src/clone-service.js), over clone.json
let cloneCleanup = null; // its pending removals (src/clone-cleanup.js); before-quit waits for its writes
let pendingOpen = args.repo; // repo to open once the window exists (CLI, early open-file)
const gitInfo = () => ({ gitVersion, gitPath });
// The image preview's HEIC, TIFF and PSD sides go through the OS thumbnailer (src/os-thumbnail.js;
// macOS only, none elsewhere): Electron's call, as a PNG (null for an empty answer).
const thumbnailer = createOsThumbnailer({
  thumbnail: async (file, size) => {
    const img = await nativeImage.createThumbnailFromPath(file, size);
    return img.isEmpty() ? null : img.toPNG();
  },
});
const runner = ops.createRunner({ log: logger.child('ops'), thumbnailer });
// Records the renderer sends over app:log (validated, size-capped, rate-limited per page).
const rendererLog = createRendererLogSink({ logger: logger.child('renderer') });
// The recent list the renderer and the menu were last given (src/recent-view.js); openRecent must pick from it.
const recentView = createRecentView({ store: () => recent });
const logWatch = (message, err) => watchLog.warn(message, { err });

// Created below; the harness and the UI port reach them lazily.
let windowHost = null;
let controller = null;
let opening = null;
let diagnostics = null;

// ---------------------------------------------------------------- the UI port

// The --smoke harness (main/smoke.js), only in smoke runs. The functions reach what is created
// further down (the window, the open use cases) when the run starts.
const harness = smoke ? require('./main/smoke')({
  options: smoke,
  window: () => windowHost.get(),
  createWindow: () => windowHost.create(),
  layout: () => controller.layout(),
  get tabs() { return controller.tabs; },
  pageTabs: () => controller.pageTabs(),
  stripHeight: STRIP_H,
  restoreTabs: () => restoreTabs(),
  opening: () => opening,
  quitGuard: { run: () => quitGuard.run() },
  runner,
  diagnosticsText: () => diagnostics.diagnosticsText(),
  git: gitInfo,
}) : null;

/** A native message box on the window (or app-modal when there is none). */
const showBox = (opts) => windowHost.showBox(opts);

/**
 * The UI port: every question, focus change and error dialog goes through it. The desktop one
 * shows native dialogs; the smoke harness's is headless (never asks, never focuses, a
 * transparent window).
 *   interactive: false when nothing may ask (quit / close guards cancel, untrusted repos refuse);
 *   confirm(options): a native message box, true for its first button;
 *   focus(target): target.focus() (the window, a tab's page);
 *   showError(title, err): an error dialog;
 *   present(win): show the new window once it is ready.
 */
const ui = harness ? harness.ui : {
  interactive: true,
  confirm: async (opts) => (await showBox(opts)).response === 0,
  focus: (target) => target.focus(),
  showError: (title, err) => {
    showBox({ type: 'error', message: title, detail: (err && err.message) || String(err) })
      .catch((e) => log.error('dialog failed', { err: e }));
  },
  present: (w) => w.once('ready-to-show', () => w.show()),
};

/** Log a failure; show it in a dialog too when `title` is given (ui.showError). */
function report(title) {
  return (err) => {
    log.error(title || 'error', { err });
    if (title) ui.showError(title, err);
  };
}

// ---------------------------------------------------------------- quitting

// Quitting while git runs (src/quit-guard.js): ask, then cancel every op and kill what is left,
// so no detached git outlives the app. The runner is shared, so this covers the writes of every
// tab. Without a UI (smoke) it never asks: it cancels and logs.
const quitGuard = createQuitGuard({
  runner,
  killChildren,
  smoke: !ui.interactive,
  confirm: confirmWith(ui.confirm),
  log: (message) => quitLog.info(message),
});
// The OS thumbnailer removes its temp copies when its calls end: a quit waits for them (cancelled
// with the reads, they end when the OS answers), at most this long.
const THUMBNAILS_QUIT_MS = 2000;
let thumbnailsWaited = false;
// A clone's folder is written to clone.json as soon as it exists (src/clone-cleanup.js journal);
// a quit approved meanwhile waits for that write, at most this long, so the next launch can
// remove what a cancelled clone left (even one whose git outlived its kill).
const CLONE_JOURNAL_QUIT_MS = 2000;
let cloneJournalWaited = false;

// One decision at a time; once it says quit, before-quit and the window close let it through.
const quitFlow = createQuitFlow({
  guard: quitGuard,
  quit: () => app.quit(),
  log: quitLog,
  running: () => runner.running().map((r) => r.op),
});

// ---------------------------------------------------------------- window and tabs

let releaseClosing = null; // the window is closing: its tabs close, but tabs.json keeps them

windowHost = createWindowHost({
  ui,
  isMac,
  stripUrl: TABS_URL,
  addKeys: (contents) => controller.addTabKeys(contents),
  report,
  hooks: {
    layout: () => controller.layout(),
    fullscreen: () => controller.updateStrip(),
    focus: () => controller.retryActive(),
    // Closing the last window quits (except on macOS, unless headless): ask on this window while
    // it still exists.
    close(e) {
      if ((isMac && ui.interactive) || !quitFlow.needsConfirm()) {
        if (!releaseClosing) releaseClosing = controller.suppressPersist();
        return;
      }
      e.preventDefault();
      quitFlow.request();
    },
    closed(stripId) {
      rendererLog.forget(stripId);
      if (!releaseClosing) releaseClosing = controller.suppressPersist();
      // No window, no tabs: their repos close (tabs.json still has them for the next window).
      controller.destroyAll();
      releaseClosing();
      releaseClosing = null;
    },
  },
});

controller = createTabsController({
  windowHost,
  runner,
  rendererLog,
  ui,
  isMac,
  indexUrl: INDEX_URL,
  viewPrefs: {
    ...SECURE_WEB_PREFS,
    preload: path.join(__dirname, 'preload.js'),
    // Lets the page expose its debug/probe globals (window.PL, the tab debug calls) only for smoke runs.
    additionalArguments: smoke ? ['--pl-smoke'] : [],
  },
  createWatcher,
  logWatch,
  store: () => tabsStore,
  report,
  log: tabLog,
  // App ops (clone): their runner events name the target's absolute path, which no page gets.
  privateOps: ops.APP_OPS,
  onTabClosed: (s) => { if (cloneService) cloneService.sessionClosed(s); },
});

/** The recent list changed outside an open (cleared, an entry dropped): the menu and every page. */
async function recentChanged() {
  await recentView.refresh();
  menu.build();
  controller.broadcast(EVENTS.RECENT_CHANGED, { recent: recentView.shown });
}

// Opening a repo whose own config or hooks run commands asks first (src/repo-trust.js).
// Without a UI (smoke) it never asks: it refuses with kind 'untrusted'.
const repoTrust = createRepoTrust({ git, store: () => trustedRepos, ui, log });

/**
 * The clone dialog's "Choose where to clone" (src/clone-service.js), from the current parent: the
 * chosen folder, or null. The smoke harness answers it from its environment instead.
 */
async function pickCloneFolder({ defaultPath }) {
  const opts = { title: 'Choose where to clone', properties: ['openDirectory', 'createDirectory'], ...(defaultPath ? { defaultPath } : {}) };
  const res = await windowHost.showOpenDialog(opts);
  return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
}

/** The folder dialog (File > Open Repository…): the chosen folder, or null. */
async function pickFolder({ newTab = false } = {}) {
  const opts = { title: newTab ? 'Open Repository in New Tab' : 'Open Repository', properties: ['openDirectory', 'createDirectory'] };
  const res = await windowHost.showOpenDialog(opts);
  return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
}

// Every open (src/repo-opening.js): where it goes, the trust prompt, the recent list, the pages.
opening = createRepoOpening({
  tabs: controller.tabs,
  openRepo: ops.openRepo,
  listWorktrees: git.worktrees,
  trust: repoTrust,
  recent: () => recent,
  recentView,
  place: {
    addTab: (o) => controller.addTab(o),
    activate: (id) => controller.activateTab(id),
    front: () => controller.bringToFront(),
    setRepo: (s, info) => controller.setRepo(s, info),
  },
  pickFolder,
  onRecentChanged: recentChanged,
  onOpened: () => menu.build(),
  ui: { interactive: ui.interactive, showError: (title, err) => report(title)(err) },
  log,
  tabLog,
});

/** Reopen the tabs of tabs.json in the window (main/tabs-controller.js). */
const restoreTabs = () => controller.restoreTabs(opening.openBackgroundTab);

diagnostics = createDiagnosticsUi({ ui, showBox, windowAlive: () => windowHost.alive(), quit: () => quitFlow.request(), git: gitInfo });

const menu = createAppMenu({
  isMac, recentView, recent: () => recent, recentChanged, controller, opening: () => opening, diagnostics, report,
});

/** Every IPC channel (main/ipc.js), plus the smoke harness's own. */
function registerIpc() {
  registerChannels({
    ipcMain,
    senderContext: createSenderContext({
      window: () => windowHost.get(), tabs: controller.tabs, pages: { index: INDEX_HTML, strip: TABS_HTML }, smoke: !!smoke,
    }),
    handlers: {
      ...createHandlers({
        runner, controller, opening: () => opening, recentView, rendererLog, openTerminal, summary: ops.summary, shouldForgetRecent, git: gitInfo, log, clipboard, listWorktrees: git.worktrees, shell,
        clone: cloneService,
      }),
      ...(harness ? harness.handlers : {}),
    },
    hasTab: (id) => !!controller.tabs.get(id),
    log: ipcLog,
    smoke: !!smoke,
  });
  controller.forwardRunnerEvents();
}

// Every web contents: no navigation, no popups, no <webview>.
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (e) => e.preventDefault());
  contents.on('will-redirect', (e) => e.preventDefault());
  contents.on('will-attach-webview', (e) => e.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});

// ---------------------------------------------------------------- lifecycle

// Unhandled errors. The handlers are deliberate: with no 'uncaughtException' listener
// Electron shows its own "A JavaScript error occurred in the main process" box and keeps running,
// and Node ends the process on an unhandled rejection without a word in our log.
// - unhandledRejection: logged, the app keeps running (as before): these are async failures of one
//   action (a dialog, a menu click), and the main process state is still consistent.
// - uncaughtException: logged and flushed. Smoke runs report it and exit 1 as before (the harness's
//   exit runs the quit guard, so no git outlives them). Otherwise a corrupted main process must not
//   limp on: cancel our git ops (SIGTERM for the ones whose cancel they outlive; the phases that
//   can't be cancelled finish on their own, as when quitting), show a native error box, flush
//   and exit 1.
let fatal = false;
process.on('unhandledRejection', (reason) => log.error('unhandled rejection', { err: reason }));
process.on('uncaughtException', (err) => {
  log.error('uncaught exception', { err });
  logger.flushSync();
  if (harness) {
    harness.exit({ ok: false, error: `uncaught exception: ${err && err.message}` }, 1);
    return;
  }
  if (fatal) return; // a second one while the error box is up
  fatal = true;
  try {
    runner.cancelAll();
    // sync: the error box blocks the event loop and app.exit follows it, so on Windows the kill
    // (taskkill, then the MSYS commands of git's hooks) must be done before either.
    killChildren({ signal: 'SIGTERM', sync: true });
  } catch { /* exiting anyway */ }
  try {
    dialog.showErrorBox(`${APP_NAME} hit an unexpected error`, `${redactString((err && err.message) || String(err), 500)}\n\n`
      + `The app will quit now. Details are in the log (Help → Show Logs next time, or ${logsDir() || 'the logs folder'}).`);
  } catch { /* no dialog before ready on some platforms */ }
  log.info('exiting after an uncaught exception', { code: 1 });
  logger.flushSync();
  app.exit(1);
});
process.on('exit', () => logger.flushSync());

app.enableSandbox();
app.setName(APP_NAME);
// Windows groups taskbar buttons, pins and notifications by AppUserModelID. Without the
// installer shortcut's id, the running window is a second button beside a pinned shortcut.
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

/**
 * setName moves the default userData, logs and crash-dump folders to the new name. Pin them to
 * DATA_DIR_NAME (main/window.js) so data from before the rename is kept. Before the
 * single-instance lock, which lives in userData.
 */
function pinDataPaths() {
  const userData = path.join(app.getPath('appData'), DATA_DIR_NAME);
  app.setPath('userData', userData);
  app.setAppLogsPath(process.platform === 'darwin'
    ? path.join(app.getPath('home'), 'Library', 'Logs', DATA_DIR_NAME)
    : path.join(userData, 'logs'));
  app.setPath('crashDumps', path.join(userData, 'Crashpad'));
}

// Smoke runs are their own primary instance with a throwaway userData (main/smoke.js).
if (harness) harness.setupUserData();
else {
  pinDataPaths();
  if (!app.requestSingleInstanceLock()) app.quit();
}

/**
 * Before 'ready': the log file (app.getPath('logs'); smoke runs keep it under their userData so
 * the real logs folder stays clean) and the crash reporter, local only (src/diagnostics.js):
 * minidumps stay in app.getPath('crashDumps'), nothing is uploaded.
 */
function setupLogging() {
  if (harness) harness.setupLogPaths();
  logger.configure({ dir: appPath('logs'), mirror: !!harness || !app.isPackaged });
  try {
    crashReporter.start(crashReporterOptions());
  } catch (err) {
    crashLog.warn('could not start the crash reporter', { err });
  }
  log.info('app start', {
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    os: os.release(),
    packaged: app.isPackaged,
    smoke: !!harness,
    logLevel: logger.level,
    logDir: logger.dir,
    crashDir: crashDir(),
  });
}
setupLogging();

// Crashes of our pages and of Chromium's helpers (their minidumps are in crashDumps). A tab's page
// or the strip: log, then offer Reload / Quit (never in smoke runs, and not while quitting).
// Helper processes (GPU, network, utility) are restarted by Chromium: logged only.
app.on('render-process-gone', (_e, contents, details = {}) => {
  const win = windowHost.get();
  const strip = !!win && !win.isDestroyed() && contents === win.webContents;
  const tab = controller.tabs.list().find((s) => s.webContents === contents) || null;
  const ours = strip || !!tab;
  const fields = { reason: details.reason, exitCode: details.exitCode, window: ours, tab: tab ? tab.id : null, strip };
  try { rendererLog.forget(contents.id); } catch { /* destroyed */ }
  if (details.reason === 'clean-exit') {
    crashLog.info('renderer process exited', fields);
    return;
  }
  crashLog.error('renderer process gone', fields);
  logger.flush();
  if (ours && ui.interactive && !quitFlow.approved) diagnostics.offerReload(contents, details, strip ? 'tab bar' : 'tab');
});
app.on('child-process-gone', (_e, details = {}) => {
  const expected = details.reason === 'clean-exit' || (quitFlow.approved && details.reason === 'killed');
  crashLog.log(expected ? 'info' : 'error', 'child process gone', {
    type: details.type, name: details.name, serviceName: details.serviceName, reason: details.reason, exitCode: details.exitCode,
  });
});

/** A window with the saved tabs (start, dock click, second launch without a window). */
async function openWindowWithTabs() {
  windowHost.create();
  await restoreTabs();
}

// macOS: folder dropped on the dock icon / `open -a`. May fire before 'ready'. Opens in a new tab
// (or shows the tab that has it already; an empty active tab is used).
app.on('open-file', (e, file) => {
  e.preventDefault();
  if (app.isReady() && recent) opening.openExternal(file).catch(report());
  else pendingOpen = file;
});

// Another launch forwarded its argv here. Only a repo path is honoured (never --smoke).
app.on('second-instance', (_e, argv, workingDirectory) => {
  const { repo } = parseArgs(argv, workingDirectory);
  // Not started yet (git binary, IPC, stores): start() opens it and creates the window.
  if (!recent) {
    pendingOpen = repo || pendingOpen;
    return;
  }
  if (repo) opening.openExternal(repo).catch(report());
  else if (!windowHost.get()) openWindowWithTabs().catch(report());
  const win = windowHost.get();
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

async function start() {
  // `electron .` shows Electron's own dock icon; a packaged build gets ours from its bundle.
  if (isMac && !app.isPackaged) app.dock?.setIcon(ICON);
  // Finder/Dock launches get launchd's PATH (Apple git first), so look in the usual places too.
  const found = await findGit();
  log.log(found.ok ? 'info' : 'error', found.ok ? 'git found' : 'no usable git', {
    version: found.version, path: found.path, tried: found.tried, error: found.ok ? undefined : found.error,
  });
  if (!found.ok) {
    if (harness) {
      harness.exit({ ok: false, error: found.error, tried: found.tried }, 1);
      return;
    }
    dialog.showErrorBox(`${APP_NAME} can't start`, describeGitFailure(found));
    app.quit();
    return;
  }
  setGitBinary(found.path);
  gitVersion = found.version;
  gitPath = found.path;
  // Temp folders of thumbnails an earlier run left behind (it quit while the OS worked on them).
  if (thumbnailer) thumbnailer.sweep().then((count) => { if (count) log.info('removed stale thumbnail folders', { count }); });
  // Every web permission is denied, clipboard writes included: pages copy through main
  // (the clipboard:writeText channel, main/ipc.js).
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  trustedRepos = createTrustStore(path.join(app.getPath('userData'), 'trusted.json'));
  tabsStore = createTabsStore(path.join(app.getPath('userData'), 'tabs.json'));
  recent = createRecentStore(path.join(app.getPath('userData'), 'recent.json'));
  // Clone: the last parent folder and the removals a quit or a crash interrupted (clone.json);
  // those are finished now, in the background (src/clone-cleanup.js checks each folder first).
  const clonePrefs = createClonePrefs(path.join(app.getPath('userData'), 'clone.json'), { log: cloneLog });
  cloneCleanup = createCleanup({
    prefs: clonePrefs,
    log: cloneLog,
    // Never removed, whatever clone.json says: a folder the recent list or a saved tab names.
    keep: keepListed(async () => [...(await recent.list()).map((e) => e.root), ...tabsStore.load().roots]),
  });
  cloneCleanup.resume().catch((err) => cloneLog.warn('could not finish the pending removals', { err }));
  cloneService = createCloneService({
    runner,
    opening,
    prefs: clonePrefs,
    cleanup: cloneCleanup,
    // No default parent: the user picks one (a smoke run: main/smoke.js seeds clone.json).
    pickFolder: harness ? harness.clone.pickFolder : pickCloneFolder,
    log: cloneLog,
  });
  registerIpc();
  await recentView.refresh();
  menu.build();
  if (harness) {
    await harness.run();
    return;
  }
  // An open that arrived while the recent list was read may have created the window already
  // (with that tab): the saved tabs are restored next to it.
  if (!windowHost.get()) windowHost.create();
  await restoreTabs();
  if (pendingOpen) {
    const dir = pendingOpen;
    pendingOpen = null;
    await opening.openExternal(dir);
  }
}

app.whenReady().then(start).catch((err) => {
  log.error('startup failed', { err });
  if (harness) {
    harness.exit({ ok: false, error: `startup failed: ${err && err.message}` }, 1);
    return;
  }
  dialog.showErrorBox(APP_NAME, `Startup failed: ${(err && err.message) || err}`);
  app.quit();
});

app.on('activate', () => {
  if (app.isReady() && recent && !windowHost.get()) openWindowWithTabs().catch(report());
});

app.on('window-all-closed', () => {
  controller.destroyAll();
  if (!isMac || !ui.interactive) app.quit();
});

app.on('before-quit', (e) => {
  if (quitFlow.needsConfirm()) {
    e.preventDefault(); // a write is running or queued: the quit flow asks, cancels, then quits
    quitFlow.request();
    return;
  }
  quitGuard.quitNow(); // cancel running reads (a no-op after an approved quit)
  controller.closeWatchers();
  if (cloneCleanup && cloneCleanup.writing() && !cloneJournalWaited) {
    cloneJournalWaited = true;
    e.preventDefault(); // quit again once clone.json holds every clone folder made so far
    quitLog.info('waiting for clone.json');
    Promise.race([cloneCleanup.persisted(), new Promise((r) => { setTimeout(r, CLONE_JOURNAL_QUIT_MS); })]).finally(() => app.quit());
    return;
  }
  if (thumbnailer && thumbnailer.busy() && !thumbnailsWaited) {
    thumbnailsWaited = true;
    e.preventDefault(); // quit again once the thumbnailer's temp folders are gone (or the wait is over)
    quitLog.info('waiting for the OS thumbnailer');
    Promise.race([thumbnailer.idle(), new Promise((r) => { setTimeout(r, THUMBNAILS_QUIT_MS); })]).finally(() => app.quit());
    return;
  }
  quitLog.info('quitting');
});

app.on('will-quit', () => logger.flushSync());
