'use strict';
// The tab strip's only door to the main process (renderer/tabs.html, the window's own contents).
// Sandboxed preload like preload.js: self-contained, ipcRenderer is never exposed. Main
// accepts only the tab channels from this page (src/tabs.js routeSender): no ops, no repo paths.
const { contextBridge, ipcRenderer } = require('electron');

async function call(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (res && res.ok) return res.value;
  throw (res && res.error) || { message: 'Unknown error', kind: null, exitCode: null };
}

const tabId = (id) => Number(id);

// app:log, as in preload.js: fire and forget, small and cloneable.
const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);
const LOG_MAX = 8 * 1024;
function sendLog(level, msg, fields) {
  try {
    const lvl = String(level);
    if (!LOG_LEVELS.has(lvl)) return;
    let f;
    if (fields && typeof fields === 'object') {
      const json = JSON.stringify(fields);
      f = json && json.length <= LOG_MAX ? JSON.parse(json) : { truncated: json ? json.length : 0 };
    }
    ipcRenderer.send('app:log', lvl, String(msg).slice(0, LOG_MAX), f);
  } catch {
    /* logging must never break the page */
  }
}

contextBridge.exposeInMainWorld('tabsApi', {
  /** macOS: the strip leaves room for the traffic lights. */
  isMac: process.platform === 'darwin',
  /** {tabs: [{id, title, root|null, active, linked, tooltip, busy}], fullscreen}; linked: a linked worktree's tab (tree icon). */
  list: () => call('tabs:list'),
  /** cb({tabs, fullscreen}) on every change; returns an unsubscribe function. */
  subscribe: (cb) => {
    if (typeof cb !== 'function') throw new Error('subscribe needs a function');
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('tabs-changed', listener);
    return () => ipcRenderer.removeListener('tabs-changed', listener);
  },
  /** Show tab `id`; {keepFocus: true} leaves the keyboard focus in the strip (keyboard activation). */
  activate: (id, o) => call('tabs:activate', tabId(id), { keepFocus: !!(o && o.keepFocus === true) }),
  /** Close tab `id` (main asks first while a write of it runs). Resolves true when it closed. */
  close: (id) => call('tabs:close', tabId(id)),
  /** A new empty tab, shown. Resolves its id. */
  newTab: () => call('tabs:newTab'),
  /** Drag reorder: move tab `id` to `toIndex`. Resolves its new index. */
  move: (id, toIndex) => call('tabs:move', tabId(id), Number(toIndex)),
  /** The tab's context menu (Close Tab, Close Other Tabs, Close Tabs to the Right), at the pointer. */
  menu: (id) => call('tabs:menu', tabId(id)),
  /** Add a record to main.log. Never throws. */
  log: (level, msg, fields) => { sendLog(level, msg, fields); },
});
