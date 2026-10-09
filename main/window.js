'use strict';
// The one window: its own web contents is the tab strip (renderer/tabs.html); the tab
// views (main/tabs-controller.js) sit below it. This module creates it and owns the reference;
// what its events mean for the tabs and for quitting is passed in as hooks by main.js.
const path = require('node:path');
const { BrowserWindow, dialog } = require('electron');

const ROOT = path.join(__dirname, '..');
// The user-facing name: window title, macOS app menu (About / Hide / Quit), dialogs, diagnostics.
const APP_NAME = 'Pasta Lite Git client';
// The name of the on-disk folders (userData, logs, crash dumps). It stays the pre-rename
// "Pasta Lite" so existing installs keep their recent list, tabs, trusted repos and logs;
// app.setName(APP_NAME) alone would move them (main.js pins them to this name).
const DATA_DIR_NAME = 'Pasta Lite';
// Windows' AppUserModelID (main.js): see main/app-id.js, Electron-free so its test needs no Electron.
const { APP_ID } = require('./app-id');
// The app icon (assets/). Windows and Linux take it from the window; macOS from the bundle, or
// from app.dock.setIcon in a dev run (main.js).
const ICON = path.join(ROOT, 'assets', 'icon.png');
// Height of the tab strip (renderer/tabs.css --strip-h); the tab views start below it. On macOS
// the traffic lights sit in it (trafficLightPosition centres them).
const STRIP_H = 38;
const BG = '#1B1815';

// Every page we load (the strip and the tab views): isolated, sandboxed, no Node.
const SECURE_WEB_PREFS = Object.freeze({
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  spellcheck: false,
});

/**
 * @param {{
 *   ui: {present(w: BrowserWindow): void},
 *   isMac: boolean, stripUrl: string,
 *   addKeys: (contents: Electron.WebContents) => void,
 *   report: (title: string) => (err: unknown) => void,
 *   hooks: {layout(): void, fullscreen(): void, focus(): void, close(e: Electron.Event): void, closed(stripId: number): void},
 * }} o  hooks: the window resized (layout), entered or left full screen, got the focus, is
 *   closing (close may preventDefault) or closed (stripId: its web contents' id, which is gone by
 *   then; after closed, get() is null).
 */
function createWindowHost({ ui, isMac, stripUrl, addKeys, report, hooks }) {
  let win = null;
  const alive = () => !!win && !win.isDestroyed();

  function create() {
    win = new BrowserWindow({
      width: 1280,
      height: 800,
      minWidth: 1000,
      minHeight: 600,
      show: false,
      title: APP_NAME,
      icon: ICON,
      backgroundColor: BG,
      // macOS: no title bar; the traffic lights sit in the tab strip (renderer/tabs.css leaves room).
      ...(isMac ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 12 } } : {}),
      webPreferences: { ...SECURE_WEB_PREFS, preload: path.join(ROOT, 'preload-tabs.js') },
    });
    const w = win;
    w.on('page-title-updated', (e) => e.preventDefault()); // the title follows the active tab
    ui.present(w);
    w.on('focus', () => hooks.focus());
    for (const ev of ['resize', 'maximize', 'unmaximize']) w.on(ev, () => hooks.layout());
    for (const ev of ['enter-full-screen', 'leave-full-screen']) w.on(ev, () => { hooks.layout(); hooks.fullscreen(); });
    w.on('close', (e) => hooks.close(e));
    const stripId = w.webContents.id;
    w.on('closed', () => {
      hooks.closed(stripId);
      if (win === w) win = null;
    });
    addKeys(w.webContents);
    w.webContents.loadURL(stripUrl).catch(report('Could not load the window'));
    return w;
  }

  return {
    create,
    alive,
    /** The window, or null when there is none (never a destroyed one after 'closed'). */
    get: () => win,
    /** To the tab strip. */
    sendStrip(channel, payload) {
      if (alive() && !win.webContents.isDestroyed()) win.webContents.send(channel, payload);
    },
    /** A native message box on the window (or app-modal when there is none). */
    showBox: (opts) => (alive() ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts)),
    /** The folder dialog on the window (or app-modal). */
    showOpenDialog: (opts) => (alive() ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts)),
    /** The strip's 'tabs-changed' fullscreen flag (macOS: no traffic lights to leave room for). */
    isFullScreen: () => alive() && win.isFullScreen(),
  };
}

module.exports = { createWindowHost, APP_NAME, APP_ID, DATA_DIR_NAME, ICON, STRIP_H, BG, SECURE_WEB_PREFS };
