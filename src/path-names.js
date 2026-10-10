/*
 * Pasta Lite - the file names Windows (and git) don't open as spelled: the '.git' aliases and the
 * reserved device names. Moved here from src/worktree-fs.js, which imports them back, so that the
 * clone dialog checks a folder name with the very rules main enforces (src/clone-url.js nameError).
 *
 * Pure, dependency-free. Works in Node (`require('./src/path-names.js')`) and in the browser as a
 * plain <script> (exposes `window.PLPathNames`), like src/error-kinds.js.
 *
 * isDotGitName(name, {platform}), DEVICE_NAME, WIN_INVALID_CHARS, defaultPlatform() (process.platform
 * under Node, 'linux' in a page: the renderer always passes its own, window.api.platform).
 */
(function (exports) {
  'use strict';

  const defaultPlatform = () => (typeof process !== 'undefined' && process.platform) || 'linux';

  /**
   * True when path component `name` opens the repository's '.git' (dir, or a linked worktree's /
   * submodule's pointer file): '.git' in any case (macOS and Windows file systems ignore case); on
   * Windows (`platform`) also NTFS's 8.3 short name 'GIT~1' ('GIT~2' ... when that is taken) and any
   * spelling with trailing dots or spaces, which Win32 strips ('.git.', '.git '). git refuses the
   * same names (core.protectNTFS).
   */
  function isDotGitName(name, { platform = defaultPlatform() } = {}) {
    if (platform !== 'win32') return name.toLowerCase() === '.git';
    return /^(?:\.git|git~\d+)[. ]*$/i.test(name);
  }

  // Win32's reserved device names: a file name 'nul', 'COM1' or 'aux.txt' (an extension or trailing
  // spaces don't matter, nor the case) opens the device, not a file in the folder, so a write there
  // would go to a serial port or the console. CONIN$ / CONOUT$ are the console's own; COM0 / LPT0 and
  // the superscript digits (COM¹ ...) are on Microsoft's reserved list too. Git for Windows refuses
  // the same names (is_valid_win32_path).
  const DEVICE_NAME = /^(?:aux|con|nul|prn|conin\$|conout\$|(?:com|lpt)[0-9\u00b9\u00b2\u00b3]) *(?:[.:]|$)/i;

  // Characters Win32 refuses in a file name (besides the separators and the control characters).
  const WIN_INVALID_CHARS = /[<>:"|?*]/;

  exports.isDotGitName = isDotGitName;
  exports.DEVICE_NAME = DEVICE_NAME;
  exports.WIN_INVALID_CHARS = WIN_INVALID_CHARS;
  exports.defaultPlatform = defaultPlatform;
})(typeof module !== 'undefined' ? module.exports : (window.PLPathNames = {})); // NOSONAR(S1121): the CommonJS-or-window export idiom
