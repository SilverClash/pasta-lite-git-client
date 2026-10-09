'use strict';
// Open a terminal window in a repo root (app:openTerminal). Free of Electron: the spawn function,
// the platform and the environment are passed in, so tests run every platform's path with fakes.
const path = require('node:path');
const { spawn: nodeSpawn } = require('node:child_process');
const { kindError } = require('./exec');
const { findOnPath, system32 } = require('./which');

/** Terminal programs tried on Linux and other Unixes, in order. */
const UNIX_TERMINALS = ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xfce4-terminal', 'xterm'];

/**
 * Commands that open a terminal window in `root`, to try in order (the first that starts wins):
 * [{cmd, args, cwd, wait}]. `cmd` is always an absolute path (a bare name would be looked up in
 * the repo folder first on Windows, so a planted cmd.exe would run), and always argv, never a
 * shell string, so the path can't be interpreted.
 * - macOS: `/usr/bin/open -a Terminal <root>` (wait: `open` exits once the app has the folder; a
 *   non-zero exit is a failure);
 * - Windows: a new `%SystemRoot%\System32\cmd.exe` console (detached) started in root;
 * - elsewhere: x-terminal-emulator (Debian's alternative), then common terminals, all with cwd.
 *   Each is resolved against PATH now (findOnPath: absolute entries only), and missing ones are
 *   left out, so the list may be empty. POSIX exec would not search cwd for a bare name, except
 *   through an empty or '.' PATH entry, which findOnPath skips.
 * @param {{env?: object, isFile?: (p: string) => boolean}} [o] env: process.env (SystemRoot, PATH)
 */
function terminalCommands(platform, root, { env = process.env, isFile } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('terminalCommands: root must be an absolute path');
  if (platform === 'darwin') return [{ cmd: '/usr/bin/open', args: ['-a', 'Terminal', root], cwd: root, wait: true }];
  if (platform === 'win32') return [{ cmd: path.win32.join(system32(env), 'cmd.exe'), args: [], cwd: root, wait: false }];
  return UNIX_TERMINALS
    .map((name) => findOnPath(name, { env, platform, isFile }))
    .filter(Boolean)
    .map((cmd) => ({ cmd, args: [], cwd: root, wait: false }));
}

/** Start one command: resolves once it started (with `wait`: once it exited 0), rejects otherwise. */
function startOne(spawn, c) {
  return new Promise((resolve, reject) => {
    const child = spawn(c.cmd, c.args, { cwd: c.cwd, detached: !c.wait, stdio: 'ignore', windowsHide: false });
    child.once('error', reject);
    if (c.wait) {
      child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${c.cmd} exited with code ${code}`))));
    } else {
      child.once('spawn', () => { child.unref(); resolve(); });
    }
  });
}

/**
 * Open a terminal in `root`: tries terminalCommands in order (absolute paths, argv only, no
 * shell). Resolves true once one started (macOS: once `open` exited 0); rejects with kind
 * 'no-terminal' when none could (or none was found on PATH).
 * @param {string} root
 * @param {{spawn?: typeof nodeSpawn, platform?: string, env?: object, isFile?: (p: string) => boolean}} [o]
 */
async function openTerminal(root, { spawn = nodeSpawn, platform = process.platform, env = process.env, isFile } = {}) {
  const commands = terminalCommands(platform, root, { env, isFile });
  if (!commands.length) throw kindError('no-terminal', `Could not open a terminal: none of ${UNIX_TERMINALS.join(', ')} was found on PATH`);
  const errors = [];
  for (const c of commands) {
    // A bare name would be looked up in cwd (the repo) first on Windows.
    const P = platform === 'win32' ? path.win32 : path.posix;
    if (!P.isAbsolute(c.cmd)) throw new Error(`openTerminal: refusing a non-absolute command: ${c.cmd}`);
    try {
      await startOne(spawn, c);
      return true;
    } catch (err) {
      errors.push(`${c.cmd}: ${err && err.message ? err.message : err}`);
    }
  }
  throw kindError('no-terminal', `Could not open a terminal:\n${errors.join('\n')}`);
}

module.exports = { openTerminal, terminalCommands, UNIX_TERMINALS };
