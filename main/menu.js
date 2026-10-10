'use strict';
// The application menu. Commands that act on "the repo" go to the active tab. Tab
// shortcuts: ⌘T / Ctrl+T New Tab, ⌘W / Ctrl+W Close Tab (macOS Close Window moves to ⌘⇧W),
// ⌘1–⌘8 / Ctrl+1–8 a tab and ⌘9 / Ctrl+9 the last one, Next / Previous Tab ⌘⇧] / ⌘⇧[ on macOS
// (plus Ctrl+Tab / Ctrl+Shift+Tab through the tabs controller's addTabKeys) and Ctrl+Tab /
// Ctrl+Shift+Tab elsewhere. Clone Repository… is ⇧⌘N / Ctrl+Shift+N (⌘N stays free for a later
// New Repository…). None of these keys is in the renderer's table (renderer/actions.js KEYS).
const { app, Menu } = require('electron');
const { EVENTS, MENU_COMMANDS } = require('../src/ipc-contract');

/**
 * @param {{
 *   isMac: boolean,
 *   recentView: {readonly shown: {root: string, name: string}[]},
 *   recent: () => ({clear(): void} | null),
 *   recentChanged: () => Promise<void>,
 *   controller: ReturnType<typeof import('./tabs-controller').createTabsController>,
 *   opening: () => ReturnType<typeof import('../src/repo-opening').createRepoOpening>,
 *   diagnostics: ReturnType<typeof import('./diagnostics-ui').createDiagnosticsUi>,
 *   report: (title?: string) => (err: unknown) => void,
 * }} o
 * @returns {{build(): void}} build: rebuild the menu from the recent list last shown
 *   (recentView.refresh first when it may have changed).
 */
function createAppMenu({ isMac, recentView, recent, recentChanged, controller, opening, diagnostics, report }) {
  const fromActive = () => controller.tabs.active();

  function clearRecent() {
    try {
      recent().clear();
    } catch (err) {
      report('Could not clear the recent list')(err);
    }
    recentChanged().catch(report());
  }

  function build() {
    const list = recentView.shown;
    const recentItems = list.length
      ? list.map((e) => ({ label: e.name, sublabel: e.root, toolTip: e.root, click: () => { opening().openFromMenu(fromActive(), e.root).catch(report()); } }))
      : [{ label: 'No Recent Repositories', enabled: false }];
    const selectItems = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({
      label: n === 9 ? 'Select Last Tab' : `Select Tab ${n}`,
      accelerator: `CmdOrCtrl+${n}`,
      click: () => controller.selectTab(n),
    }));
    const openDialog = (o) => { opening().openFromDialog(fromActive(), o).catch(report('Could not open repository')); };
    const template = [
      ...(isMac ? [{ role: 'appMenu' }] : []),
      {
        label: 'File',
        submenu: [
          { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => controller.addTab() },
          { type: 'separator' },
          { label: 'Open Repository…', accelerator: 'CmdOrCtrl+Shift+O', click: () => openDialog() },
          { label: 'Open Repository in New Tab…', click: () => openDialog({ newTab: true }) },
          // The page runs the dialog (renderer/clone.js): in the active tab, or a New Tab when there is none.
          { label: 'Clone Repository…', accelerator: 'CmdOrCtrl+Shift+N', click: () => { controller.commandToActive(MENU_COMMANDS.CLONE).catch(report()); } },
          {
            label: 'Open Recent',
            submenu: [
              ...recentItems,
              { type: 'separator' },
              { label: 'Clear Recent', enabled: list.length > 0, click: clearRecent },
            ],
          },
          { type: 'separator' },
          { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => { const a = fromActive(); if (a) controller.closeTab(a.id).catch(report()); } },
          isMac ? { role: 'close', label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W' } : { role: 'quit' },
        ],
      },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [
          // Developer items only when running unpackaged (`npm start`). They act on the focused page.
          ...(app.isPackaged ? [] : [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }]),
          // The graph's column widths live in the renderer (PLColumns); it resets them on this command.
          {
            label: 'Reset Column Widths',
            click: () => { const a = fromActive(); if (a) a.send(EVENTS.MENU_COMMAND, { id: MENU_COMMANDS.RESET_COLUMN_WIDTHS }); },
          },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      {
        label: 'Window',
        role: 'window',
        submenu: [
          { role: 'minimize' },
          { role: 'zoom' },
          { type: 'separator' },
          { label: 'Next Tab', accelerator: isMac ? 'Command+Shift+]' : 'Ctrl+Tab', click: () => controller.cycleTab(1) },
          { label: 'Previous Tab', accelerator: isMac ? 'Command+Shift+[' : 'Ctrl+Shift+Tab', click: () => controller.cycleTab(-1) },
          { type: 'separator' },
          ...selectItems,
          ...(isMac ? [{ type: 'separator' }, { role: 'front' }] : []),
        ],
      },
      {
        role: 'help',
        submenu: [
          { label: 'Show Logs', click: () => { diagnostics.showFolder(diagnostics.logsDir()).catch(report('Could not show the logs')); } },
          { label: 'Show Crash Reports', click: () => { diagnostics.showFolder(diagnostics.crashDir()).catch(report('Could not show the crash reports')); } },
          { type: 'separator' },
          { label: 'Copy Diagnostics', click: () => { diagnostics.copyDiagnostics().catch(report('Could not copy the diagnostics')); } },
        ],
      },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  return { build };
}

module.exports = { createAppMenu };
