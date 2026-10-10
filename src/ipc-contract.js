'use strict';
// The IPC contract between main and its pages: one table of channels, who may call
// each (a tab's page, the tab strip, a tab's page in a smoke run), how each argument is coerced
// and whether the call needs the tab's repo. main/ipc.js registers exactly the channels of this
// table (a handler without an entry, or an entry without a handler, fails at startup), and
// routeSender below refuses every channel a sender isn't listed for. Free of Electron.
//
// The preloads can't import this (sandboxed: 'electron' only), so their channel literals are
// checked against it by test/ipc-contract.test.js.
const { fileURLToPath } = require('node:url');
const { kindError } = require('./exec');
const ops = require('./ops');
const { MAX_URL } = require('./clone-url');

// ---------------------------------------------------------------- argument coercers

// Each coercer takes the renderer's value (and {hasTab}) and returns what the handler gets, or
// throws kind 'invalid-args' ('unknown-op' for an op name). Main re-checks nothing of this.
const invalid = (message) => kindError('invalid-args', message);

/** Any value: the handler matches it against a list main holds (the recent list, git worktree list). */
const asIs = (v) => v;

/** A tab id from the renderer: an existing tab's. */
function tabId(id, { hasTab }) {
  if (!Number.isInteger(id) || !hasTab(id)) throw invalid('No such tab');
  return id;
}

/** A new index for tabs:move. */
function toIndex(v) {
  if (!Number.isInteger(v)) throw invalid('toIndex must be an integer');
  return v;
}

/** app.openDialog / app.openRecent options: {newTab: true} asks for a new tab, anything else is false. */
const openOptions = (o) => ({ newTab: !!(o && typeof o === 'object' && o.newTab === true) });

/** tabs:activate options: {keepFocus: true} leaves the keyboard focus where it is (the strip). */
const activateOptions = (o) => ({ keepFocus: !!(o && typeof o === 'object' && o.keepFocus === true) });

/** An opId: absent (undefined / null), or a non-empty string. */
function optionalOpId(v) {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || !v) throw invalid('opId must be a string');
  return v;
}

/** app:cancel's opId: a non-empty string. */
function opId(v) {
  if (typeof v !== 'string' || !v) throw invalid('opId must be a string');
  return v;
}

/** The longest text a page may put on the clipboard (a sha, a path, a branch name: far less). */
const CLIPBOARD_MAX = 64 * 1024;

/** clipboard:writeText's text: a string of at most CLIPBOARD_MAX characters. */
function clipboardText(v) {
  if (typeof v !== 'string') throw invalid('text must be a string');
  if (v.length > CLIPBOARD_MAX) throw invalid(`text must be at most ${CLIPBOARD_MAX} characters`);
  return v;
}

/** The longest name (UTF-16 units) and parent display (the page echoes main's) of a clone request. */
const CLONE_NAME_MAX = 255;
const CLONE_DISPLAY_MAX = 4096;

/**
 * app:clone's request {url, name, parent}: url the typed URL (at most MAX_URL), name a string of
 * at most CLONE_NAME_MAX, parent the display the page showed (at most CLONE_DISPLAY_MAX). Strings
 * without NUL. Only these three fields are picked; anything else is dropped. The refusals never quote a value: main/ipc.js logs them,
 * and a URL must not reach the log. main's clone service checks the URL and the name themselves.
 */
function cloneRequest(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw invalid('the clone request must be an object');
  const text = (x, what, max) => {
    if (typeof x !== 'string' || x.length > max || x.includes('\0')) throw invalid(`${what} must be a string of at most ${max} characters`);
    return x;
  };
  return {
    url: text(v.url, 'url', MAX_URL),
    name: text(v.name, 'name', CLONE_NAME_MAX),
    parent: text(v.parent, 'parent', CLONE_DISPLAY_MAX),
  };
}

/** The 'op' request {op, args, opId}: an op of ops.OPS (else 'unknown-op'), args a list. */
function opRequest(req) {
  const { op, args = [], opId: id } = req && typeof req === 'object' ? req : {};
  if (typeof op !== 'string' || !Object.hasOwn(ops.OPS, op)) throw kindError('unknown-op', `Unknown operation: ${op}`);
  if (!Array.isArray(args)) throw invalid('args must be a list');
  return { op, args, opId: optionalOpId(id) };
}

// ---------------------------------------------------------------- the table

// from: 'view' (a tab's page, renderer/index.html), 'strip' (the tab strip, renderer/tabs.html),
// 'smoke' (a tab's page, in smoke runs only: the smoke script drives the tabs from there).
// args: the coercers, in order (extra arguments are dropped). needsRepo: refused with 'no-repo'
// while the tab has none. send: fire and forget (ipcRenderer.send), not invoke.
const CHANNELS = Object.freeze({
  op: { from: ['view'], args: [opRequest], needsRepo: true },
  'app:getState': { from: ['view'] },
  'app:openDialog': { from: ['view'], args: [openOptions] },
  // A root from the recent list main last showed (src/repo-opening.js findShownRecent).
  'app:openRecent': { from: ['view'], args: [asIs, openOptions] },
  // A worktree of the page's own repo, checked against `git worktree list`.
  'app:openWorktree': { from: ['view'], args: [asIs], needsRepo: true },
  // Show a worktree of the page's own repo in the file manager, checked against `git worktree list`.
  'app:revealWorktree': { from: ['view'], args: [asIs], needsRepo: true },
  'app:cancel': { from: ['view'], args: [opId] },
  'app:openTerminal': { from: ['view'], needsRepo: true },
  'app:log': { from: ['view', 'strip'], send: true },
  // Plain text to the system clipboard (the details panel's Copy buttons). Main writes it: the
  // pages' permission handlers deny every web permission, clipboard-sanitized-write included.
  'clipboard:writeText': { from: ['view'], args: [clipboardText] },
  // An empty tab. No page calls it today (window.api.tabs.newTab); the strip's + button does.
  'tabs:newTab': { from: ['view', 'strip'] },
  // A page's repo picker shows the tab that has a repo open already.
  'tabs:activate': { from: ['view', 'strip'], args: [tabId, activateOptions] },
  'tabs:list': { from: ['strip', 'smoke'] },
  'tabs:close': { from: ['strip', 'smoke'], args: [tabId] },
  'tabs:move': { from: ['strip', 'smoke'], args: [tabId, toIndex] },
  'tabs:menu': { from: ['strip'], args: [tabId] },
  // The rendered state of any tab's page (main/smoke.js PROBE); registered by the smoke harness.
  'tabs:probe': { from: ['smoke'], args: [tabId] },
  // Clone Repository… (src/clone-service.js): no repo needed, so a start-screen tab can clone. The
  // page never sends a path: the parent comes from main's folder dialog and the page echoes its
  // display; the source is a typed network URL, the name one segment.
  'app:cloneDefaults': { from: ['view'] },
  'app:pickCloneParent': { from: ['view'] },
  'app:clone': { from: ['view'], args: [cloneRequest, opId] },
  'app:openCloned': { from: ['view'], args: [opId] },
});

const channelsFrom = (who, except = null) => new Set(Object.keys(CHANNELS)
  .filter((c) => CHANNELS[c].from.includes(who) && !(except && CHANNELS[c].from.includes(except))));

/** What a tab's page may call. */
const VIEW_CHANNELS = channelsFrom('view');
/** What a tab's page may call on top of VIEW_CHANNELS in a smoke run. */
const SMOKE_VIEW_CHANNELS = channelsFrom('smoke', 'view');
/** What the tab strip may call. */
const STRIP_CHANNELS = channelsFrom('strip');
/** Channels only a smoke run has: main registers them only with the smoke harness. */
const SMOKE_ONLY_CHANNELS = new Set(Object.keys(CHANNELS).filter((c) => CHANNELS[c].from.every((w) => w === 'smoke')));

// ---------------------------------------------------------------- events (main → pages)

// What main sends to the pages (preload.js EVENTS lists the same names; the strip gets only
// TABS_CHANGED, its own payload).
const EVENTS = Object.freeze({
  CHANGED: 'changed', // runner: a write settled {repo, op, ok}
  BUSY: 'busy', // runner: a write started / ended {repo, op, running, ok?}
  WATCH: 'watch', // the tab's file watcher {repo, kinds, paths?, error?}
  REPO_OPENED: 'repo-opened', // {repo, recent}
  RECENT_CHANGED: 'recent-changed', // {recent}
  MENU_COMMAND: 'menu-command', // {id: one of MENU_COMMANDS}
  TABS_CHANGED: 'tabs-changed', // pages: {tabs}; the strip: {tabs, fullscreen}
  // A clone of this tab (src/clone-service.js): {opId, phase, percent, current, total, bytes, rate,
  // done, remote} (a progress frame, src/clone-progress.js), or {opId, cleanup: 'failed', leftover}
  // (its partial folder could not be removed; leftover: the folder as shown).
  CLONE_PROGRESS: 'clone-progress',
});

/** The ids of 'menu-command' (renderer/app.js acts on them). */
const MENU_COMMANDS = Object.freeze({ RESET_COLUMN_WIDTHS: 'resetColumnWidths', CLONE: 'clone' });

// ---------------------------------------------------------------- routing

/**
 * True when `frameUrl` is a file: URL naming exactly `indexHtml` (an absolute path).
 * Compared as decoded paths, not as URL strings: Node's pathToFileURL and Chromium escape
 * characters such as '[', ']' and '%' differently. Query and fragment are ignored; file URLs
 * with a host (file://server/...) never match.
 */
function isIndexUrl(frameUrl, indexHtml) {
  if (typeof frameUrl !== 'string' || !frameUrl) return false;
  let u;
  try {
    u = new URL(frameUrl);
  } catch {
    return false;
  }
  if (u.protocol !== 'file:' || u.host !== '') return false; // WHATWG maps 'localhost' to ''
  let p;
  try {
    p = fileURLToPath(u); // rejects encoded '/' (%2F) and similar
  } catch {
    return false;
  }
  return p === indexHtml;
}

/**
 * Who is calling `channel`: {kind: 'view', id} (a tab's page), {kind: 'strip'} or null (refused).
 * Only the main frame of one of our web contents, showing its own page (index.html in a tab view,
 * tabs.html in the window's own contents), and only for its own channels.
 * @param {{senderId: number, mainFrame: boolean, url: string}} sender  mainFrame: the call came
 *   from the sender's main frame (not an iframe)
 * @param {{stripId: number|null, isView: (id: number) => boolean, isPage: (url: string, which:
 *   'index'|'tabs') => boolean, smoke?: boolean}} o  isPage: isIndexUrl against the page
 */
function routeSender({ senderId, mainFrame, url } = {}, channel, { stripId, isView, isPage, smoke = false }) {
  if (!mainFrame || typeof channel !== 'string') return null;
  if (isView(senderId)) {
    if (!VIEW_CHANNELS.has(channel) && !(smoke && SMOKE_VIEW_CHANNELS.has(channel))) return null;
    return isPage(url, 'index') ? { kind: 'view', id: senderId } : null;
  }
  if (stripId !== null && senderId === stripId) {
    return STRIP_CHANNELS.has(channel) && isPage(url, 'tabs') ? { kind: 'strip' } : null;
  }
  return null;
}

/** The runner's opId for a tab's opId: tabs can't collide, and a tab cancels only its own ops. */
const ownedOpId = (owner, id) => `t${owner}:${id}`;

module.exports = {
  CHANNELS, VIEW_CHANNELS, SMOKE_VIEW_CHANNELS, STRIP_CHANNELS, SMOKE_ONLY_CHANNELS, EVENTS, MENU_COMMANDS,
  routeSender, ownedOpId, isIndexUrl, CLIPBOARD_MAX, cloneRequest,
};
