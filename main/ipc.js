'use strict';
// Main's IPC boundary. Every channel of src/ipc-contract.js CHANNELS is registered
// here with its handler, and only those: a handler without a table entry, or a (non-smoke)
// entry without a handler, fails at startup.
//
// Security boundary: the renderer never passes a repo path. The sender check (senderContext) is
// the only source of a handler's session: a tab's page reaches its own tab, the strip no tab.
// Main holds each tab's repo and injects it into every operation, so a compromised renderer can
// only run the fixed ops in src/ops.js (which validate their arguments) against the repo the user
// opened in that tab. The paths a page may name are matched against lists main holds (the recent
// list it showed, `git worktree list`; src/repo-opening.js), for revealing in the file manager too.
//
// Every call resolves {ok: true, value} | {ok: false, error} (ops.serializeError): nothing throws
// across IPC. Arguments are coerced by the table's coercers and needsRepo is checked before the
// handler runs; those refusals are logged here. Handler failures are logged too, except for
// 'op', whose runner logs every op it runs.
const ops = require('../src/ops');
const { kindError } = require('../src/exec');
const { freshWorktreeEntry } = require('../src/repo-opening');
const { CHANNELS, SMOKE_ONLY_CHANNELS, routeSender, isIndexUrl, ownedOpId } = require('../src/ipc-contract');

/**
 * Who sent `event` on `channel`: {kind: 'view', session} (a tab's page), {kind: 'strip', session:
 * null}, or null. Only the main frame of a tab view showing index.html, or of the window's own
 * contents showing tabs.html, and each only for its own channels (routeSender).
 * @param {{window: () => Electron.BrowserWindow|null, tabs: object, pages: {index: string, strip: string}, smoke: boolean}} o
 *   pages: the absolute paths of renderer/index.html and renderer/tabs.html. smoke: a smoke run
 *   (a page may then call the smoke channels too).
 */
function createSenderContext({ window, tabs, pages, smoke }) {
  return function senderContext(event, channel) {
    const win = window();
    if (!win || win.isDestroyed()) return null;
    const wc = event.sender;
    const frame = event.senderFrame;
    if (!wc || !frame) return null;
    const route = routeSender({ senderId: wc.id, mainFrame: frame === wc.mainFrame, url: frame.url }, channel, {
      stripId: win.webContents.id,
      isView: (id) => { const s = tabs.get(id); return !!s && !s.closed && s.webContents === wc; },
      isPage: (url, which) => isIndexUrl(url, which === 'tabs' ? pages.strip : pages.index),
      smoke,
    });
    if (!route) return null;
    return route.kind === 'view' ? { kind: 'view', session: tabs.get(route.id), senderId: wc.id } : { kind: 'strip', session: null, senderId: wc.id };
  };
}

/**
 * Register `handlers` ({channel: (ctx, ...args) => value}) on `ipcMain` from the channel table.
 * @param {{ipcMain: object, senderContext: Function, handlers: object, hasTab: (id: number) => boolean,
 *   log: {info: Function, warn: Function}, smoke?: boolean, channels?: object}} o  channels: the
 *   table (tests pass their own).
 */
function registerChannels({ ipcMain, senderContext, handlers, hasTab, log, smoke = false, channels = CHANNELS }) {
  for (const channel of Object.keys(handlers)) {
    if (!Object.hasOwn(channels, channel)) throw new Error(`IPC: ${channel} has no entry in the channel table`);
  }
  for (const [channel, spec] of Object.entries(channels)) {
    const fn = handlers[channel];
    if (!fn) {
      if (SMOKE_ONLY_CHANNELS.has(channel) && !smoke) continue;
      throw new Error(`IPC: no handler for ${channel}`);
    }
    const coerce = (params) => (spec.args || []).map((c, i) => c(params[i], { hasTab }));
    if (spec.send) {
      ipcMain.on(channel, (event, ...params) => {
        const ctx = senderContext(event, channel);
        if (ctx) fn(ctx, ...params);
      });
      continue;
    }
    ipcMain.handle(channel, async (event, ...params) => {
      const ctx = senderContext(event, channel);
      if (!ctx) {
        log.warn('refused a call from an untrusted sender', { channel });
        return { ok: false, error: ops.serializeError(kindError('forbidden', 'Forbidden')) };
      }
      const tab = ctx.session ? ctx.session.id : null;
      let args;
      try {
        args = coerce(params);
        if (spec.needsRepo && !(ctx.session && ctx.session.repo)) throw kindError('no-repo', 'No repository is open');
      } catch (err) {
        log[err.kind === 'no-repo' ? 'info' : 'warn']('refused a call', { channel, kind: err.kind || null, tab, err });
        return { ok: false, error: ops.serializeError(err) };
      }
      try {
        return { ok: true, value: await fn(ctx, ...args) };
      } catch (err) {
        if (channel !== 'op') log.warn('call failed', { channel, kind: (err && err.kind) || null, err });
        return { ok: false, error: ops.serializeError(err) };
      }
    });
  }
}

/**
 * The handlers of every channel but the smoke harness's.
 * @param {{
 *   runner: object, controller: object, opening: () => object, recentView: {refresh(): Promise<object[]>},
 *   rendererLog: {accept(id, level, msg, fields): boolean}, openTerminal: (root: string) => Promise<boolean>,
 *   summary: (root: string) => Promise<object>, shouldForgetRecent: (err: unknown) => boolean,
 *   git: () => {gitVersion: string|null, gitPath: string|null}, log: {warn: Function},
 *   clipboard: {writeText: (text: string) => void},
 *   listWorktrees: (root: string) => Promise<{path: string, prunable: boolean}[]>,
 *   shell: {showItemInFolder: (fullPath: string) => void},
 * }} d  clipboard, shell: Electron's (tests pass fakes). listWorktrees: git.worktrees.
 */
function createHandlers({ runner, controller, opening, recentView, rendererLog, openTerminal, summary, shouldForgetRecent, git, log, clipboard, listWorktrees, shell }) {
  const { tabs } = controller;
  return {
    // The tab's opId, namespaced: tabs can't collide, and app:cancel reaches only its own ops.
    op: ({ session: s }, { op, args, opId }) => runner.run(s.repo.root, op, args, {
      opId: opId === undefined ? undefined : ownedOpId(s.id, opId), owner: s.id,
    }),
    async 'app:getState'({ session: s }) {
      const root = s.repo && s.repo.root;
      if (root) {
        const fresh = await summary(root).catch((err) => { // fresh head
          log.warn('could not refresh the open repo', { repo: root, err });
          // Folder gone or no longer a repo: close it instead of showing a dead repo.
          const gone = shouldForgetRecent(err) || (err && err.code === 'ENOENT');
          if (gone && s.repo && s.repo.root === root) controller.setRepo(s, null);
          return null;
        });
        // Only if that repo is still the tab's (another open or a close may have won). A changed
        // name or bare flag reaches the watcher's mode, the strip and the window title.
        if (fresh && s.repo && s.repo.root === root && s.refresh(fresh)) controller.tabsChanged();
        if (s.repo) s.watch.retry();
      }
      const { gitVersion, gitPath } = git();
      return { repo: s.repo, recent: await recentView.refresh(), gitVersion, gitPath, tabs: { count: tabs.size, id: s.id } };
    },
    'app:openDialog': ({ session: s }, o) => opening().openFromDialog(s, o),
    // By root, but only one from the list the renderer was last shown: never an arbitrary path.
    'app:openRecent': ({ session: s }, root, o) => opening().openShownRecent(s, root, o),
    // A worktree of the tab's repo: only a path `git worktree list` gives for it now.
    'app:openWorktree': ({ session: s }, wtPath) => opening().openWorktreeOf(s, wtPath),
    // Show a worktree of the tab's repo in the file manager: only a path `git worktree list`
    // gives for it now (the bare entry included; not one whose folder is gone: not-found), and
    // only if the tab still has that repo (else false).
    async 'app:revealWorktree'({ session: s }, wtPath) {
      const entry = await freshWorktreeEntry(listWorktrees, s, wtPath, { allowBare: true });
      if (!entry) return false;
      shell.showItemInFolder(entry.path);
      return true;
    },
    'app:cancel': ({ session: s }, opId) => runner.cancel(ownedOpId(s.id, opId)),
    // A terminal window in the tab's repo root (never a renderer-supplied path).
    'app:openTerminal': ({ session: s }) => openTerminal(s.repo.root),
    // Renderer log records (fire and forget): level, size and rate are checked in
    // src/renderer-log.js, the logger redacts again.
    'app:log': ({ senderId }, level, msg, fields) => { rendererLog.accept(senderId, level, msg, fields); },
    // Plain text only (coerced to a bounded string); resolves nothing.
    'clipboard:writeText': (_ctx, text) => { clipboard.writeText(text); },
    // Tabs: a page or the strip opens an empty tab; the strip also activates, closes, moves them
    // and shows a tab's context menu. Each resolves the tab id it acted on.
    'tabs:newTab': () => controller.addTab().id,
    // The strip gets stripState() ({tabs, fullscreen}), a page (smoke) the tabs-changed list.
    'tabs:list': ({ kind }) => (kind === 'strip' ? controller.stripState() : controller.pageTabs()),
    'tabs:activate': (_ctx, id, { keepFocus }) => controller.activateTab(id, { focus: !keepFocus }),
    'tabs:close': (_ctx, id) => controller.closeTab(id),
    'tabs:move': (_ctx, id, toIndex) => {
      controller.moveTab(id, toIndex);
      return tabs.indexOf(id);
    },
    'tabs:menu': (_ctx, id) => controller.showTabMenu(id),
  };
}

module.exports = { createSenderContext, registerChannels, createHandlers };
