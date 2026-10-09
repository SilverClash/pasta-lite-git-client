'use strict';
// The recent list as main last showed it (the pages' start screen and picker, the Open Recent
// menu). app:openRecent may only open a root from this list, never an arbitrary path
// (src/repo-opening.js findShownRecent). Pure: the store (src/recent.js) and the home folder are
// passed in.
const os = require('node:os');
const { homeShort } = require('./fs-paths');

const homeDir = () => {
  try {
    return os.homedir();
  } catch {
    return ''; // no home (no HOME / USERPROFILE): paths are shown in full
  }
};

/**
 * @param {{store: () => ({list(): Promise<{root: string, name: string}[]>} | null), home?: () => string}} o
 *   store: the recent store, or null before main created it (then the list is empty). home: the
 *   home folder (default os.homedir()).
 * @returns {{refresh(): Promise<{root: string, name: string, display: string}[]>, readonly shown: {root: string, name: string, display: string}[]}}
 *   refresh: re-read the list (it stats every entry) and return it; an older, slower read never
 *   replaces a newer one. shown: the list last read. display: the root as the pages show it, the
 *   home folder as '~' (fs-paths homeShort, the tab tooltips' rule): main decides it, so the
 *   pages never compare paths themselves (they don't know the platform's case rules).
 */
function createRecentView({ store, home = homeDir }) {
  let shown = [];
  let seq = 0;
  async function refresh() {
    const mine = ++seq;
    const s = store();
    const h = home();
    const list = s ? (await s.list()).map(({ root, name }) => ({ root, name, display: homeShort(root, h) })) : [];
    if (mine === seq) shown = list;
    return shown;
  }
  return { refresh, get shown() { return shown; } };
}

module.exports = { createRecentView };
