'use strict';
// Windows' AppUserModelID (main.js, via main/window.js): electron-builder's appId (package.json
// build.appId), which the installer's Start menu shortcut carries. A copy, not
// require('../package.json').build.appId: electron-builder drops `build` from the package.json it
// packs. test/ipc-contract.test.js keeps the two equal; this module has no Electron import so that
// test runs under plain Node, without the electron package installed.
const APP_ID = 'io.github.silverclash.pastalite';

module.exports = { APP_ID };
