'use strict';
// The git process: spawning `git` with the env allowlist, timeouts, cancellation, an output cap
// and byte-safe output, the config overrides every command gets (GLOBAL_ARGS), and killing what
// still runs when the app quits. It knows nothing about repositories: src/repo-dirs.js finds the
// folder a command runs in, and src/exec.js (run / out / tryOut) puts the two together. Modules
// normally require exec.js, which re-exports this one.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile, execFileSync } = require('node:child_process');
const { AsyncLocalStorage } = require('node:async_hooks');
const { findOnPath, isRunnable, isDriveAbsolute, system32 } = require('./which');
const { samePath } = require('./fs-paths');
const { logger } = require('./log');
const { summarizeArgs } = require('./redact');

const log = logger.child('git');

// Absolute path of the git binary chosen at startup (gitcheck.findGit); null = the first git on
// PATH, resolved to an absolute path here (which.findOnPath: absolute PATH entries only). Never the
// bare name: git runs with cwd = the repo, and Windows looks a bare name up in cwd first.
let gitBinary = null;
let pathGit = null; // cached PATH lookup for gitBinary = null
const GIT_EXE = process.platform === 'win32' ? 'git.exe' : 'git';

/** Use the git at absolute path `p` for every command (null: the first git on PATH). */
function setGitBinary(p) {
  if (p && !path.isAbsolute(p)) throw new TypeError(`setGitBinary: not an absolute path: ${p}`);
  gitBinary = p || null;
  pathGit = null;
}

/** The binary to spawn; throws ENOENT when there is no git on PATH. */
function gitExecutable() {
  if (gitBinary) return gitBinary;
  if (!pathGit) pathGit = findOnPath(GIT_EXE);
  if (!pathGit) throw Object.assign(new Error(`git was not found on PATH (${GIT_EXE})`), { code: 'ENOENT' });
  return pathGit;
}

// Ambient cancellation: ops runs each operation inside withSignal(signal, fn) so every git
// command it spawns (hooks included) is killed on cancel, without threading {signal} everywhere.
const signalContext = new AsyncLocalStorage();
const withSignal = (signal, fn) => signalContext.run(signal, fn);

/** Git exited with a code not in okCodes. `kind` is set by callers that classify the failure. */
class GitError extends Error {
  constructor(args, exitCode, stderr, stdout) {
    super((stderr || stdout || '').trim() || `git ${args.join(' ')} exited with ${exitCode}`);
    this.name = 'GitError';
    this.exitCode = exitCode;
    this.args = args;
    this.stderr = stderr;
    this.stdout = stdout;
    this.kind = undefined;
  }
}

/** Error with a machine-readable `kind` (e.g. 'no-upstream', 'stale'); `extra` fields are copied onto it. */
function kindError(kind, message, extra = {}) {
  return Object.assign(new Error(message), { kind }, extra);
}

/** Tag an existing error with a kind (and extras) and return it, for `throw tagError(e, ...)`. */
const tagError = (err, kind, extra = {}) => Object.assign(err, { kind }, extra);

/** The error of a cancelled operation (kind 'aborted'), for work that notices the cancel itself (not a killed git). */
const abortedError = () => kindError('aborted', 'Operation was cancelled');

// Config overrides so user config can never change output we parse.
const GLOBAL_ARGS = [
  '-c', 'core.quotePath=false',
  '-c', 'color.ui=never',
  '-c', 'color.diff=never',
  '-c', 'color.status=never',
  '-c', 'color.branch=never',
  '-c', 'log.showSignature=false',
  '-c', 'gc.auto=0',
  '-c', 'maintenance.auto=0',
  '-c', 'advice.statusUoption=false',
  // A repo's own config could otherwise run a command on every `status` (e.g. a downloaded folder).
  // This only covers fsmonitor (and ext::, below): filter drivers, core.sshCommand, credential helpers, hooks etc.
  // from the repo's config still run, so main asks before opening such a repo
  // (git.riskyLocalConfig and the others repo-trust.js asks).
  '-c', 'core.fsmonitor=false',
  // The ext:: transport runs its URL as a shell command. A repo's protocol.ext.allow=always plus
  // an ext:: remote (or a url.*.insteadOf rewriting to one) would run it on fetch; the command
  // line wins over every config file, and child gits (submodules, hooks) inherit it.
  '-c', 'protocol.ext.allow=never',
  // Work inside a submodule as little as possible. Its config (filter drivers, core.sshCommand,
  // ...) and hooks are its own, so a child git there runs them: checkout, reset, merge, rebase
  // etc. don't recurse whatever the repo's config says (submodule.recurse), and neither do fetch
  // and push (also passed --no-recurse-submodules / --recurse-submodules=no: .gitmodules can
  // override these per submodule). status and diff take --ignore-submodules=dirty
  // (working-state.js, diff-args.js), and a submodule's diff is never shown inline (diff.submodule).
  // `add -A`, `stash push` and an autostash still look inside a populated submodule (no flag
  // stops them), so the trust check reads every submodule's config and hooks (git.riskyNested).
  '-c', 'submodule.recurse=false',
  '-c', 'fetch.recurseSubmodules=false',
  '-c', 'push.recurseSubmodules=no',
  '-c', 'diff.ignoreSubmodules=dirty',
  '-c', 'diff.submodule=short',
  '-c', 'status.submoduleSummary=false',
];

const DIFF_ARGS = [
  '-c', 'diff.noPrefix=false',
  '-c', 'diff.mnemonicPrefix=false',
  '-c', 'diff.srcPrefix=a/',
  '-c', 'diff.dstPrefix=b/',
  '-c', 'diff.relative=false',
  '-c', 'diff.context=3',
  '-c', 'diff.interHunkContext=0',
];

/** Flags every patch-producing command must use, so the displayed diff equals the diff hunks.js indexes. */
const DIFF_OPTS = ['--no-ext-diff', '--no-textconv', '--no-color', '-U3'];

/** Env for commands taking pathspecs: treat every path literally (no globs or :(magic)). */
const LITERAL_ENV = { GIT_LITERAL_PATHSPECS: '1' };

// Inherited GIT_* variables can redirect git to another repo or index (e.g. GIT_DIR/GIT_INDEX_FILE
// when launched from a hook) or change pathspec semantics. Only these pass through. GIT_TRACE*
// is not among them: it writes to stderr, which is parsed and shown as error messages.
const GIT_ENV_ALLOW = /^GIT_(SSH|SSH_COMMAND|SSH_VARIANT|ASKPASS|EXEC_PATH|PROXY_COMMAND|SSL_[A-Z_]+|HTTP_[A-Z_]+|CONFIG_GLOBAL|CONFIG_SYSTEM|CONFIG_NOSYSTEM|AUTHOR_(NAME|EMAIL|DATE)|COMMITTER_(NAME|EMAIL|DATE))$/; // NOSONAR(S5843): a flat allowlist of variable names

function baseEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === 'LANG' || k === 'LANGUAGE') continue;
    if (k.startsWith('GIT_') && !GIT_ENV_ALLOW.test(k)) continue;
    env[k] = v;
  }
  return {
    ...env,
    LC_ALL: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_EDITOR: 'true', // never open an editor (merge/rebase messages)
    // Defence in depth: a plain `git rebase` never opens a sequence editor, but a repo's
    // sequence.editor must not be able to run through any other path either. The env variables
    // take precedence over sequence.editor / core.editor config. Interactive rebase commands
    // replace both with the constant helper command (src/rebase.js).
    GIT_SEQUENCE_EDITOR: 'true',
  };
}

// Every git process still running, for killChildren (quitting) and releaseKilledLock. Each
// entry: {signal, cwd, startedAt, kill(sig, {sync})}.
const liveChildren = new Set();

// Windows: every git command gets a random value of this variable, which its hooks and every
// process they start inherit. It names the MSYS processes of the command when it is cancelled
// (signalGroup); nothing else reads it.
const KILL_TOKEN_VAR = 'PASTA_LITE_GIT_ID';

// Run by Git for Windows' sh with "$1" = 'PASTA_LITE_GIT_ID=<token>': SIGKILL every MSYS process
// whose environment holds it (/proc/<pid>/environ, NUL-separated; kill is the shell's builtin,
// by MSYS pid), and print how many. The sh itself and its grep don't carry the token (it is an
// argument, not env). grep's own errors are dropped: processes end while it reads (and another
// user's can't be read), which is no failure. A missing grep or /proc is one (exit 3 / 4, with a
// message on stderr), instead of a silent "nothing matched".
const MSYS_KILL = '[ -x /usr/bin/grep ] || { echo "no /usr/bin/grep" >&2; exit 3; }; [ -r /proc/$$/environ ] || { echo "no /proc" >&2; exit 4; }; n=0; for f in $(/usr/bin/grep -laF -- "$1" /proc/[0-9]*/environ 2>/dev/null); do p=${f#/proc/}; kill -9 "${p%/environ}" 2>/dev/null && n=$((n+1)); done; echo "$n"';

// Where git.exe sits in a Git for Windows installation, below its root (lower case): the PATH
// shim (cmd), the root's bin, and the real binaries of each architecture (bin and git-core).
const GFW_GIT_DIRS = ['cmd', 'bin', ...['mingw64', 'mingw32', 'clangarm64'].flatMap((m) => [`${m}\\bin`, `${m}\\libexec\\git-core`])];

/**
 * The git.exe a Scoop shim runs: `<scoop>\shims\git.exe` is a generic launcher, and the git it
 * starts is named by `git.shim` next to it (`path = "<target>"`, older Scoop without the quotes).
 * null for any other git (no .shim file). Chocolatey's shims embed their target, which can't be
 * read; its git package puts Git for Windows' own cmd folder on PATH instead.
 */
function shimTarget(gitExe, readFile) {
  try {
    const m = /^\s*path\s*=\s*"?([^"\r\n]+?)"?\s*$/m.exec(readFile(gitExe.replace(/\.exe$/i, '.shim')));
    return m && isDriveAbsolute(m[1]) ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Git for Windows' MSYS sh, which runs git's hooks: <root>\usr\bin\sh.exe for a git.exe in one of
 * GFW_GIT_DIRS under <root> (a Scoop shim: for the git it runs). Never looked for further up, so
 * an unrelated MSYS above git's own folder is never picked. null when there is none (MinGit,
 * another build): then nothing of git's runs in MSYS either. `isFile` / `readFile` for tests.
 */
function msysShell(gitExe, { isFile = (p) => isRunnable(p, 'win32'), readFile = (p) => fs.readFileSync(p, 'utf8') } = {}) {
  const dir = path.win32.dirname(shimTarget(gitExe, readFile) || gitExe);
  const parts = dir.toLowerCase().split(/[\\/]+/);
  for (const sub of GFW_GIT_DIRS) {
    const tail = sub.split('\\');
    if (parts.length <= tail.length || parts.slice(-tail.length).join('\\') !== sub) continue;
    const sh = path.win32.join(dir, ...tail.map(() => '..'), 'usr', 'bin', 'sh.exe');
    if (isFile(sh)) return sh;
  }
  return null;
}

const msysShells = new Map(); // git.exe -> msysShell(git.exe), looked up on the first cancel
const msysShellOf = (gitExe) => {
  if (!msysShells.has(gitExe)) {
    const sh = msysShell(gitExe);
    // Once per git: without it a cancel still ends git's Windows process tree, but a command a
    // hook forked keeps running (and holding git's output, so the command settles when it ends).
    if (!sh) log.warn('no Git for Windows sh found for git: a cancel will not reach the MSYS commands its hooks fork', { git: gitExe });
    msysShells.set(gitExe, sh);
  }
  return msysShells.get(gitExe);
};

/**
 * Send `sig` to the whole process group of `child` (git is spawned detached: its hooks, ssh, etc.).
 *
 * Windows has no process groups or signals, so git's processes are ended one way or another, all
 * at once and hard (a SIGTERM there is a SIGKILL already, and a later SIGKILL finds nothing left):
 * - `taskkill /PID <git> /T /F` ends git and the processes it started, found by their parent
 *   pid. Windows keeps an exited process's children with its pid as their parent and recycles
 *   pids, so a stale child of an earlier process that had git's pid would match too; taskkill
 *   skips those: it counts a process as a child only when it started after its parent (checked
 *   with Windows 11 24H2's taskkill: an orphan whose parent pid had been handed to a new process
 *   survived `taskkill /PID <new> /T`, the new process's own children did not).
 * - The MSYS processes of a hook are not all in that tree: when the hook's sh runs a command
 *   (`sleep 30`, not `exec sleep 30`), the forked sh that starts it exits right away (MSYS keeps
 *   its pid in its own process table only), so the command's Windows parent is gone and /T never
 *   reaches it. It would run on, holding git's stdout / stderr, so the command would not even
 *   settle until it ended. Those carry git's KILL_TOKEN_VAR: Git for Windows' sh (`sh`, next to
 *   git) kills every MSYS process that does (MSYS_KILL), by its environment, not by a pid,
 *   once taskkill is done.
 * The returned promise resolves once both are done (each finished, failed or timed out), and
 * spawnGit settles the command only then: git's `close` can come first (taskkill ended every
 * process holding its output, or a hook's background command doesn't hold it), and a cancelled
 * command whose hook still runs a moment longer would let the next one start beside it.
 * taskkill runs detached (outside libuv's kill-on-close job), so it still finishes when the app
 * exits right after asking. The MSYS kill is not (a detached console program's children would
 * open console windows); a quit waits for the cancelled command to settle, which is after it.
 * The exit after an uncaught exception can't wait for callbacks: it passes run = execFileNow,
 * which runs both to the end before returning (killChildren's `sync`).
 *
 * git itself may have exited already while the command still looks busy: Node reports the exit
 * at once but `close` waits for stdout / stderr, which a hook's background job (`task &`) holds
 * open. taskkill is then skipped (git's pid may already be another process's), but the MSYS kill
 * still runs: it names the job by the token, not a pid, and ending it lets the command settle.
 *
 * Whatever inherited the token dies with the command, daemons included: an MSYS gpg-agent a
 * signed commit started, an ssh ControlPersist master. They start again on their next use.
 *
 * taskkill names git by pid. Node holds git's handle until it has seen git exit, and that is
 * checked (exitCode / signalCode) right before taskkill is started, so an exit we know of never
 * sends it. But taskkill opens the pid a few ms later, in its own process: a git that exits in
 * that window frees its pid, and in the unlikely case Windows hands it to a new process first,
 * that process (and with /T its children) is the one ended. No filter closes the window (an
 * image-name filter would still match another git), so it is kept as short as a separate program
 * allows. A taskkill failure (git gone meanwhile, no taskkill) is logged and falls back to killing
 * git itself through Node's handle, which never names a pid.
 * @param {{platform?: string, env?: object, run?: typeof execFile, logTo?: object, token?: string,
 *   sh?: string|null}} [o] token: the command's KILL_TOKEN_VAR value; sh: Git for Windows' sh
 *   (msysShell); run: execFile, or execFileNow (killChildren's `sync`); platform / env / logTo,
 *   and any run, for tests
 * @returns {Promise<void>|null} Windows: resolves once the kill is done (never rejects); null
 *   when there is nothing to wait for (POSIX: the signal is sent already; no pid)
 */
function signalGroup(child, sig, {
  platform = process.platform, env = process.env, run = execFile, logTo = log, token = null, sh = null,
} = {}) {
  if (platform !== 'win32') {
    try {
      process.kill(-child.pid, sig);
    } catch {
      child.kill(sig);
    }
    return null;
  }
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  if (!child.pid) return null;
  let finished;
  const killed = new Promise((resolve) => { finished = resolve; });
  const fallback = (e) => {
    // Exited meanwhile: the expected race (debug); otherwise git's tree may still run (warn).
    logTo.log(exited() ? 'debug' : 'warn', 'taskkill failed', { pid: child.pid, error: e.code || e.message });
    try { child.kill(sig); } catch { /* gone */ }
  };
  // Only once git is gone: a hook whose commands were killed first would return, and git would
  // go on with the commit (or merge, ...) the user cancelled.
  const killMsys = () => {
    if (!token || !sh) return finished();
    const failed = (e, stderr) => logTo.log('warn', 'killing the MSYS processes failed', {
      pid: child.pid, error: e.code || e.message, ...(String(stderr || '').trim() ? { detail: String(stderr).trim().slice(0, 200) } : {}),
    });
    try {
      run(sh, ['-c', MSYS_KILL, 'sh', `${KILL_TOKEN_VAR}=${token}`], { windowsHide: true, timeout: 10000 }, (err, stdout, stderr) => {
        if (err) failed(err, stderr || err.stderr);
        else logTo.log('debug', 'killed the MSYS processes of a git', { pid: child.pid, killed: Number(String(stdout || '').trim()) || 0 });
        finished();
      });
    } catch (e) {
      failed(e);
      finished();
    }
  };
  if (exited()) {
    killMsys();
    return killed;
  }
  try {
    const taskkill = path.win32.join(system32(env), 'taskkill.exe');
    run(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, detached: true, timeout: 10000 }, (err) => {
      if (err) fallback(err);
      killMsys();
    });
  } catch (e) {
    fallback(e);
    killMsys();
  }
  return killed;
}

/**
 * execFile's callback form, run to the end before it returns (the callback included): for the
 * exit after an uncaught exception, which can't wait for the event loop (killChildren's `sync`).
 */
function execFileNow(file, args, opts, cb) {
  let err = null;
  let stdout = '';
  try {
    stdout = execFileSync(file, args, { ...opts, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    // execFile's error carries the exit code as `code`; execFileSync's as `status`.
    err = Object.assign(e, e.code === undefined && e.status !== null ? { code: e.status } : {});
  }
  cb(err, stdout, err && err.stderr);
}

// Subcommands that take the index lock, and may hold it across a hook or the whole run: the only
// ones whose kill can leave an index.lock behind. A read never takes it: GIT_OPTIONAL_LOCKS=0
// (baseEnv) stops status / diff from refreshing the index opportunistically, and clean and
// ls-files read it without a lock. `apply` only with --index / --cached.
const INDEX_WRITERS = new Set([
  'add', 'am', 'checkout', 'cherry-pick', 'commit', 'merge', 'mv', 'pull', 'read-tree', 'rebase', 'reset',
  'restore', 'revert', 'rm', 'stash', 'switch', 'update-index', 'write-tree',
]);
// git's own options before the subcommand that take the next argument as their value.
const GIT_VALUE_OPTS = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix']);

/** Whether `args` (git's argv: GLOBAL_ARGS and -c pairs first) run a command that writes the index (INDEX_WRITERS). */
function writesIndex(args) {
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) i += GIT_VALUE_OPTS.has(args[i]) ? 2 : 1;
  if (i >= args.length) return false;
  if (args[i] === 'apply') return args.slice(i + 1).some((a) => a === '--index' || a === '--cached');
  return INDEX_WRITERS.has(args[i]);
}

/**
 * The index.lock a git started in `cwd` with `env` takes, found without running git (it is
 * looked at before the command starts and again right before a kill, neither of which can wait):
 * GIT_INDEX_FILE's, or the index of the worktree whose root is `cwd`: its .git folder, or the git
 * dir a .git file names (a linked worktree's own index). null when cwd is no worktree root
 * (exec.run starts commands there; gitAt elsewhere) or .git can't be read: no lock is released.
 * releaseKilledLock checks it against `rev-parse --git-path index` before removing anything.
 */
function indexLockPath(cwd, env) {
  try {
    if (env && env.GIT_INDEX_FILE) return `${path.resolve(cwd, env.GIT_INDEX_FILE)}.lock`;
    const dotGit = path.join(cwd, '.git');
    const st = fs.lstatSync(dotGit, { throwIfNoEntry: false });
    if (st && st.isDirectory()) return path.join(dotGit, 'index.lock');
    if (!st || !st.isFile()) return null;
    const m = /^gitdir: *([^\r\n]+)/.exec(fs.readFileSync(dotGit, 'utf8'));
    return m ? path.join(path.resolve(cwd, m[1].trim()), 'index.lock') : null;
  } catch {
    return null;
  }
}

/**
 * What tells one file at `p` from another created there later: its id (device and inode; on
 * Windows the NTFS file index) and when it was last written. Not its creation time, which NTFS
 * hands on to a file re-created under the same name within seconds ("tunneling"), as each new
 * index.lock is. null when nothing is there; lstat, so a link or junction is never followed.
 * Throws when it can't be read.
 */
function fileIdentity(p) {
  const st = fs.lstatSync(p, { bigint: true, throwIfNoEntry: false });
  return st ? { dev: st.dev, ino: st.ino, file: st.isFile(), mtimeMs: Number(st.mtimeMs) } : null;
}

/** One file, both times (a file system without file ids, ino 0, never matches). */
const sameFile = (a, b) => !!(a && b) && a.ino !== 0n && a.dev === b.dev && a.ino === b.ino;

/**
 * Windows: what releaseKilledLock needs to tell the index.lock a killed `args` left from another
 * program's. null (nothing is ever released) unless the command writes the index (writesIndex)
 * and its lock's path is known. `before`: the lock already there when the command started, which
 * is never ours (git can't take a lock that exists: ours would fail at once).
 */
function watchIndexLock(args, cwd, env, platform = process.platform) {
  if (platform !== 'win32' || !writesIndex(args)) return null;
  const lock = indexLockPath(cwd, env);
  if (!lock) return null;
  try {
    return { path: lock, before: fileIdentity(lock), killedAt: null, atKill: null };
  } catch {
    return null;
  }
}

/**
 * Called before the kill of the watched command's git is sent (the first one counts): the time
 * and the lock as it is then. A git that had already exited on its own (its output still held by
 * a hook's background job) is no kill: it removed its own lock, so nothing is noted.
 */
function noteKill(watch, child) {
  if (!watch || watch.killedAt !== null) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  watch.killedAt = Date.now();
  try {
    watch.atKill = fileIdentity(watch.path);
  } catch {
    watch.atKill = null; // can't be read: nothing to release
  }
}

/**
 * After the app hard-killed a git on Windows: remove the index.lock it left. A git that ends
 * normally or on a POSIX signal removes its lock files itself; one ended by taskkill /F can't,
 * and the next command that writes the index would fail ("index.lock: File exists") until the
 * user deleted it by hand. Only for a command that writes the index (watchIndexLock), and only
 * the lock that was there when it was killed (noteKill), still the same file now (sameFile: one
 * someone removed and another git re-created is kept), not the one there when it started
 * (`before`), written after it started (`since`), with no other git of ours started in that
 * folder before the kill (one still running may hold it). A link or folder is never removed.
 * What is left is a lock another program's git took after our command started while ours held
 * none yet (e.g. while it ran a pre-commit hook of its own): git's own message then names it.
 * Only the index's lock (checked against rev-parse --git-path, so a GIT_INDEX_FILE in `env` and
 * a linked worktree's own index count): a cancel lands in a hook or the network, while git holds
 * the index lock across a hook (commit -a, merge, rebase); ref and config locks are held for a
 * moment only. Never throws; resolves what it did, for tests.
 * @param {{path: string, before: object|null, atKill: object|null, killedAt: number|null}} watch
 * @returns {Promise<'removed'|'none'|'kept'|'busy'|'failed'>}
 */
async function releaseKilledLock(cwd, env, since, { path: lock, before, atKill, killedAt }) {
  try {
    if (killedAt === null || !atKill) return 'none';
    if (!atKill.file || atKill.mtimeMs < since || sameFile(atKill, before)) return 'kept';
    const mine = (c) => c.cwd && samePath(path.resolve(c.cwd), path.resolve(cwd)) && c.startedAt <= killedAt;
    if ([...liveChildren].some(mine)) return 'busy';
    const rel = (await gitAt(cwd, ['rev-parse', '--git-path', 'index'], { env, signal: null, timeout: 10000 })).stdout.trim();
    if (!samePath(`${path.resolve(cwd, rel)}.lock`, lock)) return 'kept';
    const now = fileIdentity(lock);
    if (!now) return 'none';
    if (!now.file || !sameFile(now, atKill)) return 'kept';
    fs.rmSync(lock);
    log.info('removed the index.lock of a killed git', { ms: Math.round(killedAt - atKill.mtimeMs) });
    return 'removed';
  } catch (e) {
    log.warn('could not release the index.lock of a killed git', { error: e.code || e.kind || 'error' });
    return 'failed';
  }
}

/**
 * Signal the process groups of running git commands; returns how many were signalled. By
 * default only commands whose cancellation signal was aborted (a cancel that git outlived); with
 * `all`, every one, including commands run without a signal (the phases that must not be cut
 * short: undo's reversal, a discard's backup record). For quitting: a detached git would
 * otherwise keep running after the app exits. `sync`: on Windows, the kill (taskkill, then the
 * MSYS kill) is done before this returns, for an exit that follows at once (signalGroup).
 */
function killChildren({ all = false, signal: sig = 'SIGKILL', sync = false } = {}) {
  let n = 0;
  for (const c of liveChildren) {
    if (!all && !(c.signal && c.signal.aborted)) continue;
    c.kill(sig, { sync });
    n++;
  }
  return n;
}

/** Default cap on stdout + stderr of one command; beyond it the command fails with kind 'too-large'. */
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

function spawnGit(cwd, args, {
  input, env, okCodes = [0], encoding = 'utf8', timeout, signal = signalContext.getStore(), maxBytes = MAX_OUTPUT_BYTES,
}) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(tagError(new GitError(args, null, 'git was cancelled', ''), 'aborted'));
      return;
    }
    const win = process.platform === 'win32';
    const exe = gitExecutable();
    const token = win ? crypto.randomBytes(8).toString('hex') : null; // signalGroup's KILL_TOKEN_VAR
    const t0 = Date.now(); // before git exists: a lock it writes is never older (releaseKilledLock)
    const lockWatch = watchIndexLock(args, cwd, env); // Windows: the lock a kill may leave
    // detached: no controlling terminal, so ssh cannot block on a tty prompt (passphrase, host key).
    // Not on Windows, where it means a process without a console: each console program git starts
    // (sh for a hook, ssh) would then open a console window of its own. windowsHide gives git a
    // hidden console instead (CREATE_NO_WINDOW: stdio is piped), which those inherit. It applies to
    // git's own window only: a credential helper's sign-in window (Git Credential Manager) is
    // started by git, and shows as usual.
    const child = spawn(exe, args, {
      cwd, env: { ...baseEnv(), ...env, ...(token ? { [KILL_TOKEN_VAR]: token } : {}) }, detached: !win, windowsHide: true,
    });
    // One record per command (debug; a kill for timeout / size is a warning). The argv is
    // summarized (no -c overrides, messages, or pathspecs: a count), stdin is never logged.
    const record = (fields) => {
      const level = killedBy === 'timeout' || killedBy === 'too-large' ? 'warn' : 'debug';
      if (!log.enabled(level)) return;
      log.log(level, 'git command', {
        argv: summarizeArgs(args), ms: Date.now() - t0, ...(input ? { withStdin: true } : {}), ...(killedBy ? { killed: killedBy } : {}), ...fields,
      });
    };
    const out = [];
    const err = [];
    let bytes = 0;
    let killedBy = null;
    let killing = null; // Windows: the kills sent, until they are done (signalGroup)
    const signalTree = (sig, { sync = false } = {}) => {
      noteKill(lockWatch, child);
      const k = signalGroup(child, sig, { token, sh: win ? msysShellOf(exe) : null, ...(sync ? { run: execFileNow } : {}) });
      if (k) killing = killing ? Promise.all([killing, k]) : k;
    };
    const kill = (why) => {
      if (killedBy) return;
      killedBy = why;
      signalTree('SIGTERM');
    };
    const entry = { signal, cwd, startedAt: t0, kill: (sig, o) => { killedBy = killedBy || 'aborted'; signalTree(sig, o); } };
    liveChildren.add(entry);
    const timer = timeout ? setTimeout(() => kill('timeout'), timeout) : null;
    const onAbort = () => kill('aborted');
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const done = () => {
      liveChildren.delete(entry);
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    // Buffers beyond maxBytes are dropped: Buffer.concat / toString would throw (or exhaust memory).
    const collect = (list) => (d) => {
      if (killedBy) return;
      bytes += d.length;
      if (bytes > maxBytes) kill('too-large');
      else list.push(d);
    };
    child.stdout.on('data', collect(out));
    child.stderr.on('data', collect(err));
    child.on('error', (e) => {
      done();
      record({ spawnError: e.code || e.message });
      reject(e);
    });
    const finish = (code) => {
      try {
        if (killedBy) {
          const why = {
            timeout: `timed out after ${timeout} ms`,
            aborted: 'was cancelled',
            'too-large': `output exceeded ${maxBytes} bytes`,
          }[killedBy];
          return reject(tagError(new GitError(args, code, `git ${why}`, ''), killedBy));
        }
        const raw = Buffer.concat(out);
        const stdout = encoding === 'buffer' ? raw : raw.toString(encoding);
        const stderr = Buffer.concat(err).toString('utf8');
        if (okCodes.includes(code)) resolve({ stdout, stderr, code });
        else reject(new GitError(args, code, stderr, encoding === 'buffer' ? raw.toString('utf8') : stdout));
      } catch (e) {
        reject(e); // e.g. ERR_STRING_TOO_LONG: never leave the promise pending
      }
    };
    child.on('close', (code) => {
      done();
      record({ code, ...(okCodes.includes(code) || killedBy ? {} : { failed: true }) });
      // Settled once the kill is done (on Windows git's `close` can come first: the hook's
      // MSYS processes may still run, see signalGroup) and a lock the hard kill left is gone, so
      // the next command neither runs beside the cancelled one's hook nor trips on its lock.
      const release = lockWatch && lockWatch.killedAt !== null;
      if (killing || release) {
        Promise.resolve(killing)
          .then(() => release && releaseKilledLock(cwd, env, t0, lockWatch))
          .then(() => finish(code));
      } else {
        finish(code);
      }
    });
    child.stdin.on('error', () => {}); // git may exit before reading stdin
    child.stdin.end(input);
  });
}

/**
 * `git <GLOBAL_ARGS> [DIFF_ARGS] <args>` in the folder `dir` as given (no worktree-root lookup:
 * see exec.run), with spawnGit's options (`diff: true` adds DIFF_ARGS).
 */
function gitAt(dir, args, opts = {}) {
  return spawnGit(dir, [...GLOBAL_ARGS, ...(opts.diff ? DIFF_ARGS : []), ...args], opts);
}

/**
 * gitAt()'s stdout, or null when git fails (a GitError without a kind). Cancellation, timeouts,
 * 'too-large' and other errors (e.g. git missing) propagate.
 */
async function tryGitAt(dir, args, opts) {
  try {
    return (await gitAt(dir, args, opts)).stdout;
  } catch (e) {
    if (e instanceof GitError && !e.kind) return null;
    throw e;
  }
}

/** NUL-terminated path list for --pathspec-from-file=- --pathspec-file-nul. */
const nulList = (paths) => paths.map((p) => `${p}\0`).join('');

// Windows has no argv: CreateProcess takes one command line of at most 32,767 UTF-16 code units,
// the quoted executable and every argument included (`spawn ENAMETOOLONG` beyond). Of that,
// WIN_EXE_RESERVE is kept for git's path (a long-path install, its quotes) and the rest is shared
// by GLOBAL_ARGS / DIFF_ARGS, the command's own arguments and the paths.
const WIN_CMDLINE_MAX = 32767;
const WIN_EXE_RESERVE = 4096;

/**
 * Code units `arg` takes on a Windows command line, its separating space included, at most: Node
 * (libuv's quote_cmd_arg) quotes an argument with a space, tab or '"' (or an empty one), escapes
 * each '"' and may double a '\\' before one, so every '"' and '\\' counts twice.
 */
function winArgLength(arg) {
  if (arg === '') return 3;
  if (!/[ \t"]/.test(arg)) return arg.length + 1;
  return arg.length + (arg.match(/["\\]/g) || []).length + 3;
}

/**
 * Split paths into argv-sized chunks (git clean has no --pathspec-from-file): at most `maxCount`
 * paths and `maxBytes` of them each; on Windows (`platform`) also a command line that fits, with
 * GLOBAL_ARGS, DIFF_ARGS and `prefix` (the command's arguments before the paths) counted.
 */
function argvChunks(paths, { maxCount = 1000, maxBytes = 64 * 1024, prefix = [], platform = process.platform } = {}) {
  const win = platform === 'win32';
  const fixed = [...GLOBAL_ARGS, ...DIFF_ARGS, ...prefix].reduce((n, a) => n + winArgLength(a), 0);
  const maxChars = win ? WIN_CMDLINE_MAX - WIN_EXE_RESERVE - fixed : Infinity;
  const chunks = [];
  for (const p of paths) {
    const len = Buffer.byteLength(p) + 1;
    const chars = win ? winArgLength(p) : 0;
    const last = chunks[chunks.length - 1];
    if (last && last.paths.length < maxCount && last.bytes + len <= maxBytes && last.chars + chars <= maxChars) {
      last.paths.push(p);
      last.bytes += len;
      last.chars += chars;
    } else {
      chunks.push({ paths: [p], bytes: len, chars });
    }
  }
  return chunks.map((c) => c.paths);
}

module.exports = {
  setGitBinary, withSignal, killChildren, MAX_OUTPUT_BYTES,
  GitError, kindError, tagError, abortedError, spawnGit, gitAt, tryGitAt, GLOBAL_ARGS, DIFF_ARGS, DIFF_OPTS, LITERAL_ENV, nulList, argvChunks,
  // exported for unit tests only
  _internal: {
    signalGroup, msysShell, execFileNow, releaseKilledLock, writesIndex, indexLockPath, fileIdentity, watchIndexLock, noteKill,
    KILL_TOKEN_VAR, MSYS_KILL, winArgLength, WIN_CMDLINE_MAX, WIN_EXE_RESERVE,
  },
};
