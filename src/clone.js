'use strict';
// Cloning a repository (docs/plans/clone-repository.md §5.3): create the target folder, run
// `git clone` into it with progress, classify a failure, and hand back what we created so that
// only that is ever removed (src/clone-cleanup.js). Pure Node: the IPC, the dialogs and the
// opening are src/clone-service.js and src/repo-opening.js.
//
// The folder comes first and is ours: fs.promises.mkdir (not recursive) refuses whatever is there
// already, so a clone never writes into, and its cleanup never deletes, a folder we didn't make.
// Its identity (dev, inode and, where the file system keeps one, birth time) is reported at once
// (onMade). git then runs in that new, empty folder (never the parent: git takes an scp-like
// "host:path" that exists as a folder relative to its cwd for a local path), with a transport
// allowlist on its command line (CLONE_ARGS: no file transport), the source always after '--', no
// submodules, no timeout (a large clone takes an hour; a credential manager may wait for the
// user) and a 16 MiB output cap. A cancel wins over anything git printed; "Clone succeeded, but
// checkout failed" is a result, not an error. Only the progress parser's text lines (never the
// hundreds of progress frames) make the error's message, redacted: serializeError sends it as it is.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gitAt, GitError, kindError, tagError } = require('./git-process');
const { createProgressParser } = require('./clone-progress');
const { nameError } = require('./clone-url');
const gitErrors = require('./git-errors');
const { redactString } = require('./redact');
const { homeShort } = require('./fs-paths');
const { logger } = require('./log');
const { bornOf } = require('./clone-cleanup');

const log = logger.child('clone');

// The transports a clone may use, on the command line so they beat every config file (a user's
// url.<x>.insteadOf rewriting to a helper is refused too: kind 'unsupported'). fd:: (which would
// hang reading fd 3) and every other <helper>:: transport are refused; ext:: already is
// (GLOBAL_ARGS). file is never allowed: the app clones remotes only (parseCloneUrl refuses a
// local source), and git would otherwise take an scp-like URL whose "host:path" exists as a local
// folder for that folder. These values also reach child gits (GIT_CONFIG_PARAMETERS). The tests,
// which clone local fixtures, pass localFixtures to cloneRepo (FIXTURE_ARGS: file at git's
// default 'user'); nothing in the app can.
const CLONE_ARGS = Object.freeze([
  '-c', 'protocol.allow=never',
  '-c', 'protocol.https.allow=always',
  '-c', 'protocol.http.allow=always',
  '-c', 'protocol.ssh.allow=always',
  '-c', 'protocol.git.allow=always',
  '-c', 'protocol.file.allow=never',
]);
const FIXTURE_ARGS = Object.freeze([...CLONE_ARGS.slice(0, -2), '-c', 'protocol.file.allow=user']);

const MAX_CLONE_OUTPUT = 16 * 1024 * 1024; // ~2 MiB for a ten-hour clone: stops endless remote: text only
const PROGRESS_MS = 100; // at most one progress frame per this, the latest wins
const MAX_MESSAGE = 2000; // what an error or checkout-failed message keeps of git's lines (20 of at most 500)
const WIN_LONG_TARGET = 200; // Git for Windows without core.longpaths can't check out paths over 260

// The order rules are tried in after a cancel and a checkout failure (docs/plans §5.6).
const RULE_ORDER = ['auth', 'hostKey', 'remoteNotFound', 'unreachable', 'dubiousOwnership', 'transportNotAllowed', 'noSpace', 'destinationExists'];

// Tests only: called between git's exit 0 and the post-steps (a cancel landing there).
const testHooks = { afterGit: null };

const shown = (p) => homeShort(p, os.homedir());

/** The kind and message of a failed mkdir of `target` in `parent`, or the error itself. */
function mkdirError(e, name, parent, platform) {
  switch (e && e.code) {
    case 'EEXIST':
      return kindError('exists', `A folder named ${name} already exists in ${shown(parent)}`);
    case 'EACCES':
    case 'EPERM':
      return kindError('no-access', `Pasta Lite can't create folders in ${shown(parent)}${platform === 'win32'
        ? '. Windows Security\'s Controlled folder access may be blocking it: allow Pasta Lite there, or choose another folder.' : ''}`);
    case 'EROFS':
      return kindError('no-access', `${shown(parent)} is on a read-only volume`);
    case 'ENOSPC':
      return kindError('no-space', 'The disk is full');
    case 'ENAMETOOLONG':
      return kindError('path-too-long', 'The folder path is too long');
    case 'ENOENT':
    case 'ENOTDIR':
      return kindError('not-found', `The folder ${shown(parent)} no longer exists`, { state: 'parent' });
    default:
      return e;
  }
}

/**
 * onProgress(frame) at most once per PROGRESS_MS (the latest frame wins), and always at once for a
 * new phase or a phase's `done`. stop(): nothing more is sent. A listener that throws is ignored.
 */
function throttle(onProgress, { now = Date.now } = {}) {
  let last = -Infinity;
  let lastPhase = null;
  let held = null;
  let timer = null;
  let stopped = false;
  const send = (p) => {
    clearTimeout(timer);
    timer = null;
    held = null;
    last = now();
    lastPhase = `${p.remote}:${p.phase}`;
    try {
      onProgress(p);
    } catch { /* the page's listener never breaks the clone */ }
  };
  return {
    offer(p) {
      if (stopped || !onProgress) return;
      if (p.done || `${p.remote}:${p.phase}` !== lastPhase || now() - last >= PROGRESS_MS) {
        send(p);
        return;
      }
      held = p;
      if (!timer) timer = setTimeout(() => { if (held && !stopped) send(held); }, Math.max(0, PROGRESS_MS - (now() - last)));
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      timer = null;
    },
  };
}

/** True when `p` exists (any type; a link isn't followed). */
const exists = (p) => fs.promises.lstat(p).then(() => true, () => false);

/**
 * Clone `source` into a new folder `name` in `parent`.
 * @param {{source: string, parent: string, name: string, onProgress?: (p: object) => void,
 *   onMade?: (made: {abs: string, dev: string, ino: string, born?: string}) => void, signal?: AbortSignal,
 *   platform?: string, localFixtures?: boolean}} o
 *   source: a URL parseCloneUrl accepted (the app's only source).
 *   localFixtures: tests only (local paths and file:// URLs of their fixtures; FIXTURE_ARGS). The
 *   runner's check picks the fields it passes, so no request can set it.
 *   onProgress: CloneProgress frames (src/clone-progress.js), throttled.
 *   onMade: the folder we created ({abs, dev, ino}: dev and ino as decimal strings, so they survive
 *   JSON), as soon as it exists.
 *   platform: default process.platform (tests pass 'win32' / 'darwin').
 * @returns {Promise<{status: 'done'|'checkout-failed', root: string, name: string,
 *   submodules: boolean, empty: boolean, message?: string}>}
 * Rejects with err.made set once the folder was created (the caller removes it). Kinds:
 * invalid-args, not-found (the parent is gone; the remote repository doesn't exist), exists,
 * no-access, no-space, path-too-long, auth, host-key, unreachable, unsupported, unsafe-repo,
 * aborted; none for a failure git explains in a way we don't classify.
 */
async function cloneRepo({ source, parent, name, onProgress, onMade, signal, platform = process.platform, localFixtures = false } = {}) {
  const bad = nameError(name, { platform });
  if (bad) throw kindError('invalid-args', bad);
  if (typeof source !== 'string' || !source) throw kindError('invalid-args', 'No repository to clone');
  if (typeof parent !== 'string' || !path.isAbsolute(parent)) throw kindError('invalid-args', 'The folder to clone into is not an absolute path');
  let st;
  try {
    st = await fs.promises.stat(parent);
  } catch (e) {
    throw mkdirError(e, name, parent, platform); // gone: not-found; unreadable: no-access
  }
  if (!st.isDirectory()) throw kindError('not-found', `The folder ${shown(parent)} no longer exists`, { state: 'parent' });
  const target = path.join(parent, name);
  if (platform === 'win32' && target.length > WIN_LONG_TARGET) log.warn('clone target path is long; checkout may fail without core.longpaths', { chars: target.length });

  try {
    await fs.promises.mkdir(target);
  } catch (e) {
    throw mkdirError(e, name, parent, platform);
  }
  // Its identity: dev and inode, and the birth time where the file system keeps one (an inode can
  // be reused for a later folder at the same path; src/clone-cleanup.js bornOf).
  const id = await fs.promises.lstat(target, { bigint: true });
  const born = bornOf(id);
  const made = { abs: target, dev: String(id.dev), ino: String(id.ino), ...(born ? { born } : {}) };
  if (onMade) {
    try {
      onMade(made);
    } catch { /* the caller's bookkeeping never breaks the clone */ }
  }

  const parser = createProgressParser();
  const progress = throttle(onProgress);
  const onStderr = (chunk) => { for (const p of parser.feed(chunk)) progress.offer(p); };
  try {
    // cwd: the new, empty target (absolute in the argv too), never the parent.
    await gitAt(target, [...(localFixtures ? FIXTURE_ARGS : CLONE_ARGS), 'clone', '--progress', '--no-recurse-submodules', '--', source, target], {
      signal, onStderr, maxBytes: MAX_CLONE_OUTPUT,
    });
    for (const p of parser.end()) progress.offer(p);
    progress.stop();
  } catch (err) {
    progress.stop(); // before anything awaited below: no held frame after the failure
    parser.end();
    // A cancel wins: spawnGit replaced git's text with "git was cancelled", and a cancelled git's
    // checkout error is no checkout failure.
    if ((err && err.kind === 'aborted') || (signal && signal.aborted)) {
      throw withMade(err && typeof err === 'object' ? tagError(err, 'aborted') : kindError('aborted', 'Clone cancelled'), made);
    }
    const text = parser.lines().join('\n');
    if (gitErrors.matches({ stderr: text }, 'checkoutFailed') && await exists(path.join(target, '.git'))) {
      return { status: 'checkout-failed', root: target, name, ...(await postSteps(target)), empty: false, message: redactString(told(text), MAX_MESSAGE) };
    }
    throw withMade(classified(err, text), made);
  }
  if (testHooks.afterGit) await testHooks.afterGit();
  // The clone is complete: what follows runs without the signal, so a cancel landing now can't
  // fail (and so remove) it.
  return { status: 'done', root: target, name, ...(await postSteps(target)) };
}

/**
 * What a finished clone holds: {submodules, empty}. No signal: a cancel can't fail it. A HEAD that
 * can't be read for another reason counts as not empty (opening it will say what is wrong).
 */
async function postSteps(target) {
  const submodules = await exists(path.join(target, '.gitmodules'));
  const head = await gitAt(target, ['rev-parse', '--verify', '-q', 'HEAD'], { signal: null, okCodes: [0, 1], timeout: 30000 })
    .catch(() => null);
  return { submodules, empty: !!head && !String(head.stdout).trim() };
}

/** `err` with `made` attached (what the caller removes). */
function withMade(err, made) {
  try {
    err.made = made;
  } catch { /* frozen */ }
  return err;
}

/** git's text lines without "Cloning into '<target>'...": our own target, not news. */
const told = (text) => text.split('\n').filter((l) => !/^Cloning into /.test(l)).join('\n');

/**
 * A failed git's error, classified by the progress parser's text lines `text` (never the progress
 * frames: the rules read them as stderr). Its message is always replaced, redacted and bounded:
 * git's lines (told), else the kill's own text (spawnGit's, which names no URL), else a plain one.
 * A GitError's own message would be git's whole stderr, or with none its command line, URL included.
 */
function classified(err, text) {
  if (!(err instanceof GitError)) return err;
  const kill = err.kind ? err.message : '';
  err.stderr = text || '';
  gitErrors.classify(err, RULE_ORDER);
  err.message = redactString(told(text) || kill || 'git clone failed', MAX_MESSAGE);
  return err;
}

module.exports = {
  cloneRepo, CLONE_ARGS,
  _internal: { testHooks, throttle, mkdirError, classified, RULE_ORDER, MAX_CLONE_OUTPUT, FIXTURE_ARGS }, // exported for unit tests only
};
