'use strict';
// Finding programs on PATH without ever picking one from the current folder (the repo), and the
// Windows system folder by an absolute path. Pure Node: used by git-process.js (the git to spawn,
// taskkill), gitcheck.js, shell.js and terminal.js.
const fs = require('node:fs');
const path = require('node:path');

/**
 * True when `p` is a drive-absolute Windows path ('C:\\x', 'C:/x'). Paths from the environment
 * (SystemRoot, ProgramFiles, ...) must be: a relative one would name the current folder (the
 * repo), and a UNC one ('\\\\server\\share') a folder on another machine.
 */
const isDriveAbsolute = (p) => /^[a-z]:[\\/]/i.test(String(p || ''));

/**
 * %SystemRoot%\System32 (for taskkill.exe, cmd.exe), always absolute: a bare program name is
 * looked up in the current folder first on Windows. A SystemRoot that is not drive-absolute
 * falls back to C:\Windows.
 */
function system32(env = process.env) {
  const root = env && isDriveAbsolute(env.SystemRoot) ? env.SystemRoot : 'C:\\Windows';
  return path.win32.join(root, 'System32');
}

/** True when `p` is a regular file this process may run (on Windows: any regular file). */
function isRunnable(p, platform = process.platform) {
  try {
    if (!fs.statSync(p).isFile()) return false;
    if (platform !== 'win32') fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The PATH value of `env` (Windows spells the key 'Path'; keys are case-insensitive there). */
function pathValue(env, platform) {
  if (platform !== 'win32') return env.PATH || '';
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  return key ? env[key] || '' : '';
}

/**
 * Absolute path of the first `name` (e.g. 'git', 'git.exe') on env's PATH, or null. Only absolute
 * PATH entries count: empty entries and '.' (which mean the current folder) and relative ones are
 * skipped, so a program planted in the repo folder is never picked. Callers spawn the result
 * instead of the bare name, because Windows' own lookup searches the child's cwd (the repo) first.
 * @param {{env?: object, platform?: string, isFile?: (p: string) => boolean}} [o]
 */
function findOnPath(name, { env = process.env, platform = process.platform, isFile = (p) => isRunnable(p, platform) } = {}) {
  const P = platform === 'win32' ? path.win32 : path.posix;
  for (const dir of pathValue(env || {}, platform).split(platform === 'win32' ? ';' : ':')) {
    const d = dir.trim().replace(/^"(.*)"$/, '$1'); // Windows allows quoted entries
    if (!d || d === '.' || !P.isAbsolute(d)) continue;
    const full = P.join(d, name);
    if (isFile(full)) return full;
  }
  return null;
}

module.exports = { findOnPath, isRunnable, isDriveAbsolute, system32 };
