'use strict';
// The git process: spawning `git` with the env allowlist, timeouts, cancellation, an output cap
// and byte-safe output, the config overrides every command gets (GLOBAL_ARGS), and killing what
// still runs when the app quits. It knows nothing about repositories: src/repo-dirs.js finds the
// folder a command runs in, and src/exec.js (run / out / tryOut) puts the two together. Modules
// normally require exec.js, which re-exports this one.
const path = require('node:path');
const { spawn } = require('node:child_process');
const { AsyncLocalStorage } = require('node:async_hooks');
const { findOnPath } = require('./which');
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

// Every git process still running, for killChildren (quitting). Each entry: {signal, kill(sig)}.
const liveChildren = new Set();

/** Send `sig` to the whole process group of `child` (git is spawned detached: its hooks, ssh, etc.). */
function signalGroup(child, sig) {
  try {
    process.kill(process.platform === 'win32' ? child.pid : -child.pid, sig);
  } catch {
    child.kill(sig);
  }
}

/**
 * Signal the process groups of running git commands; returns how many were signalled. By
 * default only commands whose cancellation signal was aborted (a cancel that git outlived); with
 * `all`, every one, including commands run without a signal (the phases that must not be cut
 * short: undo's reversal, a discard's backup record). For quitting: a detached git would
 * otherwise keep running after the app exits.
 */
function killChildren({ all = false, signal: sig = 'SIGKILL' } = {}) {
  let n = 0;
  for (const c of liveChildren) {
    if (!all && !(c.signal && c.signal.aborted)) continue;
    c.kill(sig);
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
    // detached: no controlling terminal, so ssh cannot block on a tty prompt (passphrase, host key).
    const child = spawn(gitExecutable(), args, { cwd, env: { ...baseEnv(), ...env }, detached: process.platform !== 'win32' });
    const t0 = Date.now();
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
    const kill = (why) => {
      if (killedBy) return;
      killedBy = why;
      signalGroup(child, 'SIGTERM');
    };
    const entry = { signal, kill: (sig) => { killedBy = killedBy || 'aborted'; signalGroup(child, sig); } };
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
    child.on('close', (code) => {
      done();
      record({ code, ...(okCodes.includes(code) || killedBy ? {} : { failed: true }) });
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

/** Split paths into argv-sized chunks (git clean has no --pathspec-from-file). */
function argvChunks(paths, { maxCount = 1000, maxBytes = 64 * 1024 } = {}) {
  const chunks = [];
  for (const p of paths) {
    const len = Buffer.byteLength(p) + 1;
    const last = chunks[chunks.length - 1];
    if (last && last.paths.length < maxCount && last.bytes + len <= maxBytes) {
      last.paths.push(p);
      last.bytes += len;
    } else {
      chunks.push({ paths: [p], bytes: len });
    }
  }
  return chunks.map((c) => c.paths);
}

module.exports = {
  setGitBinary, withSignal, killChildren, MAX_OUTPUT_BYTES,
  GitError, kindError, tagError, abortedError, spawnGit, gitAt, tryGitAt, GLOBAL_ARGS, DIFF_ARGS, DIFF_OPTS, LITERAL_ENV, nulList, argvChunks,
};
