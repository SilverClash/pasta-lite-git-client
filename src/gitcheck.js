'use strict';
// Startup check: find a git that is new enough (undo needs `git reflog write`).
// Apps launched from Finder/Dock get launchd's PATH (/usr/bin first → Apple Git, often too old),
// so the user's login-shell PATH and the usual package-manager locations are tried first. On
// Windows: the git on PATH, then Git for Windows' install folders (an app started before git was
// installed, or from a shortcut, may have a PATH without it).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { findOnPath, isDriveAbsolute } = require('./which');
const { samePath } = require('./fs-paths');

const MIN_VERSION = [2, 51, 0];

/**
 * [major, minor, patch] from `git --version` output or a bare version, or null.
 * Handles "git version 2.51.2", "2.39.3 (Apple Git-145)", "2.51.0.windows.1", "2.52.0-rc1".
 */
function parseVersion(text) {
  const m = /(?:^|\s)(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(text || '').replace(/^\s*git version/i, ' '));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
}

/** <0, 0 or >0 like a sort comparator. */
function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** How to install or update git on `platform`, for the "not found" / "too old" texts. */
function installHint(platform = process.platform) {
  if (platform === 'darwin') return 'e.g. `brew install git`';
  if (platform === 'win32') return 'e.g. `winget install --id Git.Git -e`, or from https://git-scm.com/download/win';
  return "e.g. with your distribution's package manager, or see https://git-scm.com/download/linux";
}

/** Evaluate `git --version` output: {ok, version, error}. `platform` picks the install hint. */
function evaluate(output, { platform = process.platform } = {}) {
  const v = parseVersion(output);
  if (!v) return { ok: false, version: null, error: `Could not read the git version from: ${String(output).trim() || '(no output)'}` };
  const version = v.join('.');
  if (compareVersions(v, MIN_VERSION) < 0) {
    return { ok: false, version, error: `Pasta Lite needs git ${MIN_VERSION.join('.')} or newer, but found git ${version}. Please update git (${installHint(platform)}).` };
  }
  return { ok: true, version, error: null };
}

/** The first git on PATH as an absolute path (absolute PATH entries only), or null. */
const pathGit = ({ env = process.env, platform = process.platform } = {}) =>
  findOnPath(platform === 'win32' ? 'git.exe' : 'git', { env, platform });

const NOT_FOUND = `git was not found. Install git ${MIN_VERSION.slice(0, 2).join('.')} or newer and make sure it is on your PATH.`;

/**
 * Run `git --version` (gitPath overridable for tests; default: the git on PATH) and evaluate it.
 * Only an absolute gitPath is run: a bare name could be found in the current folder on Windows.
 * Never rejects.
 */
function checkGit({ gitPath = pathGit(), timeout = 10000 } = {}) {
  return new Promise((resolve) => {
    if (!gitPath || !path.isAbsolute(gitPath)) {
      resolve({ ok: false, version: null, error: gitPath ? `Refusing to run git from a relative path: ${gitPath}` : NOT_FOUND });
      return;
    }
    execFile(gitPath, ['--version'], { timeout, env: { ...process.env, LC_ALL: 'C' }, windowsHide: true }, (err, stdout) => {
      if (err) {
        const missing = err.code === 'ENOENT';
        resolve({
          ok: false,
          version: null,
          error: missing
            ? NOT_FOUND
            : `Running "git --version" failed: ${err.message}`,
        });
      } else {
        resolve(evaluate(stdout));
      }
    });
  });
}

// Finder/Dock launches may lack $SHELL; fall back to the account's login shell.
const defaultShell = () => process.env.SHELL || (() => { try { return os.userInfo().shell; } catch { return null; } })();

/** Absolute path of `git` on the user's login-shell PATH, or null. Never rejects. */
function loginShellGit({ shell = defaultShell(), timeout = 5000 } = {}) {
  if (!shell || process.platform === 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(shell, ['-ilc', 'command -v git'], { timeout, env: process.env, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      // rc files may print banners: take the last line that is an absolute path.
      const line = String(stdout).split('\n').map((l) => l.trim()).filter((l) => path.isAbsolute(l)).pop();
      resolve(line || null);
    });
  });
}

/**
 * The usual places of a git not on PATH: Homebrew's (macOS, also tried elsewhere), or on Windows
 * Git for Windows' install folders: machine-wide (64- and 32-bit) and per user. Built from env;
 * an unset or not drive-absolute variable is skipped (never a relative candidate).
 */
function wellKnownGits({ platform = process.platform, env = process.env } = {}) {
  if (platform !== 'win32') return ['/opt/homebrew/bin/git', '/usr/local/bin/git'];
  const at = (v, ...rest) => (isDriveAbsolute(v) ? path.win32.join(v, ...rest) : null);
  return [
    at(env.ProgramFiles, 'Git', 'cmd', 'git.exe'),
    at(env.ProgramW6432, 'Git', 'cmd', 'git.exe'), // the 64-bit folder, seen from a 32-bit process
    at(env['ProgramFiles(x86)'], 'Git', 'cmd', 'git.exe'),
    at(env.LOCALAPPDATA, 'Programs', 'Git', 'cmd', 'git.exe'),
  ].filter(Boolean);
}

/**
 * The git binaries findGit tries by default, in order. macOS / Linux: the login shell's git, the
 * usual package-manager locations, then the git on PATH (a Finder / Dock launch has launchd's
 * PATH, whose /usr/bin/git is often too old). Windows: the git on PATH first, then Git for
 * Windows' install folders: an app started normally has the user's PATH, and a git there is the
 * user's choice (scoop, MinGit, a portable git) over one that happens to be installed too.
 * `loginShell` / `onPath` (pathGit) for tests.
 */
async function defaultGitCandidates({
  platform = process.platform, env = process.env, loginShell = loginShellGit, onPath = pathGit,
} = {}) {
  const wellKnown = wellKnownGits({ platform, env });
  if (platform === 'win32') return [onPath({ env, platform }), ...wellKnown].filter(Boolean);
  return [await loginShell(), ...wellKnown, onPath({ env, platform })].filter(Boolean);
}

/**
 * Try candidate git binaries in order and return the first new enough:
 * {ok, version, path, error, tried:[{path, version, error}]}. Default candidates:
 * defaultGitCandidates. `path` is always absolute: a relative candidate is never run (checkGit
 * refuses it), so a git.exe planted in a repo can't be picked up. On failure, `error` describes
 * the best (newest) git found, or that none was found. Never rejects.
 */
async function findGit({ candidates, platform = process.platform } = {}) {
  const list = candidates || await defaultGitCandidates({ platform });
  // One binary under several names is run once: a link, or on Windows another spelling of the
  // same path (PATH's 'c:\program files\git\cmd' and ProgramFiles' 'C:\Program Files\...'),
  // which only the native realpath and a case-insensitive compare (samePath) bring together.
  const seen = [];
  const tried = [];
  for (const p of list) {
    const key = path.isAbsolute(p) ? (() => { try { return fs.realpathSync.native(p); } catch { return p; } })() : p;
    if (seen.some((k) => samePath(k, key, { platform }))) continue;
    seen.push(key);
    const r = await checkGit({ gitPath: p });
    tried.push({ path: p, version: r.version, error: r.error });
    if (r.ok) return { ...r, path: p, tried };
  }
  const found = tried.filter((t) => t.version).sort((a, b) => compareVersions(parseVersion(b.version), parseVersion(a.version)));
  const error = found.length
    ? `Pasta Lite needs git ${MIN_VERSION.join('.')} or newer, but the newest git found is ${found[0].version} (${found[0].path}). Please update git (${installHint(platform)}).`
    : `git was not found. Install git ${MIN_VERSION.slice(0, 2).join('.')} or newer (${installHint(platform)}).`;
  return { ok: false, version: found.length ? found[0].version : null, path: null, error, tried };
}

/** Dialog text for a failed findGit() result: the error plus every binary tried. */
function describeGitFailure(res) {
  const tried = (res && Array.isArray(res.tried) ? res.tried : []).map((t) => {
    const what = t.version ? `git ${t.version}` : 'not usable';
    const why = !t.version && t.error ? ` (${t.error})` : '';
    return `  ${t.path}: ${what}${why}`;
  });
  const head = (res && res.error) || 'No usable git was found.';
  return tried.length ? `${head}\n\nTried:\n${tried.join('\n')}` : head;
}

module.exports = {
  checkGit, findGit, defaultGitCandidates, describeGitFailure, loginShellGit, pathGit, wellKnownGits, parseVersion, compareVersions, evaluate,
};
