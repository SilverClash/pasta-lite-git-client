'use strict';
// File watcher for one repository. Pure Node, no Electron.
//
// One recursive fs.watch on the worktree root (which covers `.git` when it is a folder), plus one on
// the gitdir and/or the common dir when they live outside the root (linked worktree or submodule:
// `.git` is then a file pointing elsewhere). Every changed path is classified (classify below) and
// merged into one pending batch. Two trailing debounces decide when it is emitted as
// onEvent({kinds, paths?}): git-internal changes wait for debounceRefs of quiet (but at most
// maxWaitRefs after the first one), working-folder edits for debounceWork (at most maxWaitWork).
// Whichever fires first flushes everything pending, and 'full' subsumes every other kind.
//
// Working-folder paths are filtered through `git check-ignore --stdin -z` once per flush (never per
// event), with a short-lived cache that is dropped whenever a (non-ignored) .gitignore,
// .git/info/exclude or the index changes. Paths inside a submodule are never sent to check-ignore
// (it fails the whole batch on them): they count as a change to the submodule's gitlink, which is
// how the superproject's status shows them.
//
// fs.watch recursive is native on macOS (FSEvents) and Windows. On Linux Node (>= 20; Electron 44
// ships Node 24.21) implements it in JS: at start it walks the whole tree synchronously and adds
// one inotify watch per file and per directory, then more as entries appear. So on Linux the
// watch gets Node's `ignore` option, which prunes that walk: .git/objects, .git/logs (except the
// stash log), .git/modules, the noisy parts of .git/worktrees (see "Linked worktrees"), every node_modules, nested .git folders, and the
// ignored entries `git ls-files -o -i --exclude-standard --directory` listed at start (re-listed
// when the ignore rules change). Limitation: a folder that stops being ignored is only watched
// once something changes in its parent folder (Node re-reads the parent then); one that becomes
// ignored stays watched (its events are then filtered by check-ignore) until the repo is reopened.
// Running out of fs.inotify.max_user_watches still surfaces as an 'error' event.
//
// Linked worktrees (any repository: normal, linked or bare): the worktree list and each entry's
// lock and branch show in the UI, so worktrees (the folder), worktrees/<name>, worktrees/<name>/HEAD
// and worktrees/<name>/locked are 'refs' changes (a full refresh, which re-reads the worktrees);
// the rest of worktrees/<name> (index, logs...) is ignored. A linked worktree's own gitdir is
// worktrees/<name> in the common dir: its HEAD stays 'full', its `locked` is 'refs', and the
// sibling entries are mapped to `.git/worktrees/...` so it sees them too. On Linux the walk prunes
// the noisy parts of worktrees/ (everything but those paths) in every mode.
//
// A bare repository (option `bare`): the root is the git dir itself and there is no
// working folder. Every path is a git-internal one (classified as `.git/<path>`), so there is
// nothing to filter: no check-ignore, no submodule or ignored-entry listing, no rev-parse. Its
// linked worktrees are listed in the bare repo's banner, so a worktree added or removed
// (worktrees/<name>), locked, or switched to another branch (worktrees/<name>/HEAD) is a 'refs'
// change as in any repository (see above). On Linux the walk prunes the git dir's noisy parts
// (objects, logs, and the same parts of worktrees/) as for `.git`.
const fs = require('node:fs');
const path = require('node:path');
const { out } = require('./exec');
const { parseStageEntries } = require('./porcelain');
const { logger } = require('./log');
const { realPathSync, isAtOrUnder } = require('./fs-paths');

const watcherLog = logger.child('watcher');
/** Default `log` for createWatcher: a warning in the shared logger. */
const defaultLog = (message, err) => watcherLog.warn(message, { err });

// Files in the gitdir whose change means "the checked-out state changed" (HEAD moved, an operation
// started / advanced / ended): refresh everything.
const FULL_FILES = new Set([
  'HEAD', 'MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'AUTO_MERGE',
]);
const FULL_DIRS = ['rebase-merge', 'rebase-apply', 'sequencer'];

// Entries of a common dir that every worktree shares. The rest of a common dir (its HEAD, index,
// MERGE_HEAD...) belongs to the main worktree, not to the linked one being watched.
const SHARED = ['refs', 'objects', 'packed-refs', 'logs/refs', 'info', 'config'];

const under = (p, dir) => p === dir || p.startsWith(`${dir}/`);

// A linked worktree's folder in the common dir, and the files of it the UI shows (list, branch, lock).
const WORKTREE_ENTRY = /^worktrees(\/[^/]+(\/(HEAD|locked))?)?$/;

/** Classify a path relative to the gitdir ('/'-separated). */
function classifyGit(p) {
  if (!p || p.endsWith('.lock')) return null;
  if (WORKTREE_ENTRY.test(p)) return 'refs';
  if (p === 'locked') return 'refs'; // a linked worktree's own gitdir: worktrees/<this>/locked
  if (p === 'index') return 'status';
  if (FULL_FILES.has(p) || FULL_DIRS.some((d) => under(p, d))) return 'full';
  if (p === 'refs/stash' || p === 'logs/refs/stash') return 'stashes';
  if (under(p, 'refs/heads')) return 'full';
  // config: remotes and upstreams live there (the store re-reads remotes when refs change).
  if (under(p, 'refs/remotes') || under(p, 'refs/tags') || p === 'packed-refs' || p === 'config') return 'refs';
  if (p === 'info/exclude') return 'ignores';
  // objects/*: written by fetch, gc, hash-object... and never on their own a status change (staging
  // also writes the index). logs/* (except the stash log), FETCH_HEAD, ORIG_HEAD, hooks,
  // refs/pasta-lite, ...
  return null;
}

/**
 * What a change to `relPath` (relative to the worktree root, '/' or '\' separated; `.git/...` means
 * the repo's gitdir) calls for:
 *   'work'    a working-folder file: status, once `git check-ignore` says it isn't ignored
 *   'ignores' a .gitignore (filtered like 'work'; a non-ignored one drops the ignore cache) or
 *             .git/info/exclude (drops the ignore cache): then status
 *   'status'  .git/index
 *   'full'    HEAD, refs/heads/*, MERGE_HEAD / REBASE_HEAD / rebase-merge/ and other operation state
 *   'refs'    refs/remotes/*, refs/tags/*, packed-refs, config, and linked worktrees: worktrees,
 *             worktrees/<name>, worktrees/<name>/HEAD, worktrees/<name>/locked (and, in a linked
 *             worktree's own gitdir, `locked`)
 *   'stashes' refs/stash, logs/refs/stash
 *   null      ignored: *.lock inside .git, objects/*, other logs, anything else under .git, nested
 *             .git folders
 * A null / empty name (fs.watch did not say which file) counts as a working-folder change.
 * `*.lock` is ignored only inside .git: yarn.lock or Cargo.lock in the worktree are real files.
 */
function classify(relPath) {
  if (relPath == null) return 'work';
  const p = String(relPath).replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  if (p === '') return 'work';
  if (p === '.git') return null;
  if (p.startsWith('.git/')) return classifyGit(p.slice(5));
  const parts = p.split('/');
  if (parts.includes('.git')) return null; // a nested repo's or submodule's own git data
  return parts[parts.length - 1] === '.gitignore' ? 'ignores' : 'work';
}

/**
 * Gitdir-relative paths the Linux walk never watches (a lot of entries, nothing classify uses).
 * worktrees/ and each worktrees/<name> folder with its HEAD / locked are watched, in every mode.
 */
function noisyGit(r) {
  if (under(r, 'logs')) return !['logs', 'logs/refs', 'logs/refs/stash'].includes(r);
  if (under(r, 'worktrees')) return !WORKTREE_ENTRY.test(r);
  return ['objects', 'modules', 'lfs'].some((d) => under(r, d));
}

// More distinct working-folder paths than this in one batch (a node_modules install, a build) are
// not filtered: one status refresh is cheaper than piping them all through check-ignore. It also
// bounds what a long pause collects.
const MAX_CHECK = 5000;
const CACHE_MAX = 20000;
// event.paths is a hint for the renderer (which open diff to reload); beyond this it is left out.
const MAX_PATHS = 200;

/**
 * Default isIgnored: the subset of root-relative `paths` git ignores (one git process, two when a
 * path vanished meanwhile).
 * check-ignore reads plain pathnames (globs are literal) but refuses GIT_LITERAL_PATHSPECS and
 * fails the whole batch on a name starting with ':(' (pathspec magic), so every path is sent as
 * './<path>'; git echoes each ignored one back as it was sent. A path that no longer exists is
 * asked with a trailing '/' too: a directory-only pattern (`build/`) can't match a deleted folder
 * by its name alone. (Not for every path: `build/` would then match a regular file named build.)
 */
async function checkIgnore(root, paths) {
  const missing = (list) => list.filter((p) => !fs.existsSync(path.join(root, p)));
  const ask = async (list) => {
    const raw = await out(root, ['check-ignore', '--stdin', '-z'], {
      input: list.map((p) => `./${p}\0`).join(''), okCodes: [0, 1],
    });
    return raw.split('\0').filter(Boolean).map((p) => (p.startsWith('./') ? p.slice(2) : p).replace(/\/$/, ''));
  };
  const gone = new Set(missing(paths));
  const ignored = new Set(await ask([...paths, ...[...gone].map((p) => `${p}/`)]));
  // Deleted while git ran (a folder being removed): it may have been asked without the '/'.
  const late = missing(paths.filter((p) => !ignored.has(p) && !gone.has(p)));
  if (late.length) for (const p of await ask(late.map((p) => `${p}/`))) ignored.add(p);
  return [...ignored];
}

/** Default gitlinks: root-relative paths of the submodules recorded in the index (mode 160000). */
async function listGitlinks(root) {
  return parseStageEntries(await out(root, ['ls-files', '-s', '-z'])).filter((e) => e.mode === '160000').map((e) => e.path);
}

/** Default ignoredEntries (Linux): the untracked ignored files and folders (folders collapsed). */
async function listIgnored(root) {
  const raw = await out(root, ['ls-files', '-o', '-i', '--exclude-standard', '--directory', '-z']);
  return raw.split('\0').filter(Boolean).map((p) => p.replace(/\/$/, ''));
}

// Missing (the root went away) or unreadable: the resolved spelling is compared.
const realpath = realPathSync;

const isRuleFile = (p) => p === '.gitignore' || p.endsWith('/.gitignore');

/**
 * Watch the repository whose worktree root is `root`.
 * @param {string} root worktree root (as repo-dirs.resolveRoot / ops.openRepo report it)
 * @param {{
 *   onEvent: (e: {kinds: string[], paths?: string[], error?: Error}) => void,
 *   debounceWork?: number, maxWaitWork?: number, debounceRefs?: number, maxWaitRefs?: number,
 *   resumeGrace?: number, ignoreCacheMs?: number,
 *   isIgnored?: (paths: string[]) => Promise<Iterable<string>>,
 *   fsWatch?: typeof fs.watch, clock?: {setTimeout, clearTimeout, now},
 *   log?: (message: string, error: unknown) => void, bare?: boolean,
 * }} o
 *   kinds: any of 'status' | 'refs' | 'stashes', or exactly ['full'], ['gone'] (the root was deleted;
 *   the watcher closed itself) or ['error'] (with `error`: fs.watch failed, e.g. EMFILE / ENOSPC /
 *   EPERM; the watcher closed itself and does not retry). paths: the non-ignored working-folder
 *   paths behind a 'status' batch, only when they are all known and at most MAX_PATHS.
 *   Debounces are trailing: a batch is emitted once its lane saw no change for debounceWork
 *   (working folder, default 2 s) / debounceRefs (git-internal, 250 ms), or maxWaitWork (10 s) /
 *   maxWaitRefs (1 s) after the lane's first change, whichever comes first.
 *   resumeGrace (default debounceRefs): after the last resume(), git-internal changes (index,
 *   refs, HEAD, stashes...) are dropped for this long: they are our own write's, delivered late
 *   (FSEvents), and its 'changed' refresh covers them. Working-folder changes are kept.
 *   isIgnored: replaces `git check-ignore` (resolves the ignored subset of `paths`).
 *   log: failures that don't stop the watcher (check-ignore, listing submodules); each message
 *   is logged once.
 *   bare: `root` is a bare repository's git dir (see the header): its paths are all gitdir paths.
 *   onEvent must not throw: it runs from timers and fs callbacks.
 * @param {{gitDir?: string, platform?: string, gitlinks?: (root: string) => Promise<string[]>,
 *   ignoredEntries?: (root: string) => Promise<string[]>}} [internal] test hooks only: gitDir skips
 *   `git rev-parse` (used as the common dir too); platform replaces process.platform; gitlinks /
 *   ignoredEntries replace the `git ls-files` calls.
 * @returns {{pause(): void, resume(): void, close(): void, ready: Promise<void>}}
 *   pause() nests (counted). While paused, changes are collected but nothing is emitted; the
 *   last resume() emits at most one batch with everything collected. ready resolves once every
 *   watch is set up (or the watcher failed or closed); it never rejects.
 */
function createWatcher(root, {
  onEvent, debounceWork = 2000, maxWaitWork = 10000, debounceRefs = 250, maxWaitRefs = 1000,
  resumeGrace = debounceRefs, ignoreCacheMs = 10000, isIgnored = null, fsWatch = fs.watch,
  clock = { setTimeout, clearTimeout, now: Date.now }, log = defaultLog, bare = false,
} = {}, {
  gitDir = null, platform = process.platform, gitlinks: listLinks = listGitlinks, ignoredEntries = listIgnored,
} = {}) {
  if (typeof onEvent !== 'function') throw new TypeError('createWatcher: onEvent must be a function');
  const rootAbs = realpath(path.resolve(root));
  const ignoredSubset = isIgnored || ((paths) => checkIgnore(rootAbs, paths));
  const linux = platform === 'linux';
  // Until rev-parse answers, assume the usual layout (root/.git); events are mapped with the
  // current value, so nothing that happens meanwhile is lost. A bare root is its own git dir.
  const gitHome = bare ? rootAbs : path.join(rootAbs, '.git');
  const dirs = { git: gitHome, common: gitHome };
  const watchers = [];
  const lane = (quiet, maxWait) => ({ quiet, maxWait, first: null, last: 0, timer: null });
  const lanes = { work: lane(debounceWork, maxWaitWork), refs: lane(debounceRefs, maxWaitRefs) };
  // kinds may hold 'status' with no known paths ("blind": the working-folder paths are not known or
  // not worth filtering). work: unfiltered working-folder paths. known: already filtered, not
  // ignored (a batch merged back after racing a pause).
  const pending = { kinds: new Set(), work: new Set(), known: new Set() };
  const ignoreCache = new Map(); // root-relative path -> {ignored, at}; oldest first
  const ignores = { gen: 0, failedAt: null }; // gen: bumped per invalidation (a racing check isn't cached)
  const links = { list: [], stale: true }; // gitlink paths, re-read after an index change
  const logged = new Set();
  let skipEntries = new Set(); // Linux: root-relative ignored entries the walk skips
  let skipSeq = 0;
  let pauses = 0;
  let pauseEpoch = 0; // bumped by pause(): a flush that raced a pause is merged back, not emitted
  let graceUntil = -Infinity;
  let starting = false; // inside fsWatch(): the Linux walk's synchronous burst is not a change
  let flushing = false;
  let flushAgain = false;
  let closed = false;

  const inside = isAtOrUnder;
  const posixRel = (from, abs) => path.relative(from, abs).split(path.sep).join('/');

  function logOnce(message, err) {
    const key = `${message} ${(err && err.message) || err}`;
    if (logged.has(key)) return;
    logged.add(key);
    log(message, err);
  }

  /** Root-relative path for classify ('.git/...' for gitdir entries), or undefined to drop it. */
  function mapPath(base, name) {
    if (name == null || name === '') {
      // fs.watch did not say what changed: the worktree may have; inside a gitdir (a bare root is
      // one), assume anything.
      return base === rootAbs && !bare ? null : '.git/HEAD';
    }
    const abs = path.resolve(base, String(name));
    if (inside(abs, dirs.git)) return abs === dirs.git ? '.git' : `.git/${posixRel(dirs.git, abs)}`;
    if (dirs.common !== dirs.git && inside(abs, dirs.common)) {
      const rel = posixRel(dirs.common, abs);
      return SHARED.some((s) => under(rel, s)) || WORKTREE_ENTRY.test(rel) ? `.git/${rel}` : undefined;
    }
    if (inside(abs, rootAbs)) return posixRel(rootAbs, abs);
    return undefined;
  }

  /** Linux: whether the recursive walk skips `abs` (see the header). */
  function skipWatch(abs) {
    if (inside(dirs.git, abs)) return false; // the gitdir or one of its parents
    for (const dir of [dirs.git, dirs.common]) {
      if (inside(abs, dir)) return noisyGit(posixRel(dir, abs));
    }
    if (!inside(abs, rootAbs)) return false;
    const rel = posixRel(rootAbs, abs);
    const parts = rel.split('/');
    return parts.includes('node_modules') || parts.includes('.git') || skipEntries.has(rel);
  }

  async function loadSkipEntries() {
    if (bare) return; // no working folder: nothing is ignored
    const seq = ++skipSeq;
    try {
      const list = await ignoredEntries(rootAbs);
      if (seq === skipSeq) skipEntries = new Set(list);
    } catch (err) {
      logOnce('could not list ignored folders (watching them too):', err);
    }
  }

  function onFsEvent(base, name) {
    if (closed || starting) return;
    const rel = mapPath(base, name);
    if (rel === undefined) return;
    const kind = classify(rel);
    if (kind === null) return;
    const gitInternal = rel !== null && rel.startsWith('.git/');
    // Side effects first: they hold even for a change that emits nothing.
    if (rel === '.git/index') indexChanged(); // `git add -f`, a submodule added or removed
    if (kind === 'ignores' && gitInternal) rulesChanged();
    if (gitInternal && clock.now() < graceUntil) return; // our own write's, delivered late
    if (kind === 'work' || kind === 'ignores') {
      if (!gitInternal) {
        addWork(rel, kind === 'ignores');
        schedule('work');
        return;
      }
      pending.kinds.add('status');
    } else {
      pending.kinds.add(kind);
    }
    schedule('refs');
  }

  const blindStatus = () => pending.kinds.has('full') || pending.kinds.has('status');

  function goBlind() {
    pending.kinds.add('status');
    pending.work.clear();
    pending.known.clear();
  }

  /** Record a working-folder change (null: fs.watch didn't say which file). */
  function addWork(rel, ruleFile) {
    if (blindStatus()) {
      // Its path won't be filtered: assume a .gitignore that matters.
      if (ruleFile) rulesChanged();
      return;
    }
    if (!rel) goBlind();
    else pending.work.add(rel);
    if (pending.work.size + pending.known.size > MAX_CHECK) goBlind();
  }

  function indexChanged() {
    ignores.gen++;
    ignoreCache.clear();
    links.stale = true;
  }

  function rulesChanged() {
    ignores.gen++;
    ignoreCache.clear();
    if (linux) loadSkipEntries();
  }

  // ---------------------------------------------------------------- debounce

  const dueAt = (l) => Math.min(l.last + l.quiet, l.first + l.maxWait);

  function schedule(name) {
    const l = lanes[name];
    const now = clock.now();
    if (l.first === null) l.first = now;
    l.last = now;
    if (pauses === 0 && !l.timer) arm(l);
  }

  /** One timer per lane; when it fires early (more changes came meanwhile), it re-arms. */
  function arm(l) {
    l.timer = clock.setTimeout(() => {
      l.timer = null;
      if (clock.now() < dueAt(l)) arm(l);
      else flush();
    }, Math.max(0, dueAt(l) - clock.now()));
  }

  function clearTimers() {
    for (const l of Object.values(lanes)) {
      if (l.timer) clock.clearTimeout(l.timer);
      l.timer = null;
    }
  }

  // ---------------------------------------------------------------- filtering

  /** Gitlink (submodule) paths, re-read after an index change. Without .gitmodules: none. */
  async function currentGitlinks() {
    if (!links.stale) return links.list;
    links.stale = false; // an index change while listing sets it again
    if (!fs.existsSync(path.join(rootAbs, '.gitmodules'))) {
      links.list = [];
      return links.list;
    }
    try {
      links.list = await listLinks(rootAbs);
    } catch (err) {
      links.stale = true;
      logOnce('could not list submodules:', err);
    }
    return links.list;
  }

  /** Keep this batch's answers, evicting expired entries, then the oldest, to stay under CACHE_MAX. */
  function remember(paths, ignored, now) {
    for (const p of paths) ignoreCache.delete(p); // re-added last (newest)
    for (const [p, c] of ignoreCache) {
      if (now - c.at < ignoreCacheMs && ignoreCache.size + paths.length <= CACHE_MAX) break;
      ignoreCache.delete(p);
    }
    for (const p of paths) ignoreCache.set(p, { ignored: ignored.has(p), at: now });
  }

  /**
   * Ask git which of `paths` are ignored: a Set, or null when it can't tell (it failed, now or
   * less than ignoreCacheMs ago: a failing check is not re-run every window).
   */
  async function askGit(paths, now) {
    if (ignores.failedAt !== null && now - ignores.failedAt < ignoreCacheMs) return null;
    const gen = ignores.gen;
    let raw;
    try {
      raw = await ignoredSubset(paths);
    } catch (err) {
      ignores.failedAt = now;
      logOnce('git check-ignore failed (every changed file counts):', err);
      return null;
    }
    ignores.failedAt = null;
    const ignored = new Set(raw);
    if (gen === ignores.gen) remember(paths, ignored, now); // else the rules changed meanwhile
    return ignored;
  }

  /**
   * The non-ignored subset of working-folder `paths`, in order. A path inside a submodule is
   * replaced by the submodule's gitlink path (tracked, so never ignored).
   */
  async function unignored(paths) {
    const gitlinks = await currentGitlinks();
    const now = clock.now();
    // This batch's verdicts, read before anything is evicted from the cache.
    const verdicts = new Map();
    const unknown = [];
    for (const p of paths) {
      const link = gitlinks.find((g) => under(p, g));
      const c = link ? null : ignoreCache.get(p);
      if (link) verdicts.set(link, false);
      else if (c && now - c.at < ignoreCacheMs) verdicts.set(p, c.ignored);
      else {
        verdicts.set(p, null);
        unknown.push(p);
      }
    }
    if (unknown.length) {
      const ignored = await askGit(unknown, now);
      for (const p of unknown) verdicts.set(p, !!ignored && ignored.has(p));
    }
    return [...verdicts].filter(([, isIgnored]) => !isIgnored).map(([p]) => p);
  }

  /** The batch's non-ignored working-folder paths, or null when they are not known (blind status). */
  async function resolvePaths({ kinds, work, known }) {
    if (kinds.has('full')) return [];
    if (kinds.has('status')) return null;
    if (!work.length) return known;
    // refs means a full refresh in the renderer: which files changed doesn't matter, so don't ask.
    if (kinds.has('refs')) return null;
    return [...new Set([...known, ...(await unignored(work))])];
  }

  // ---------------------------------------------------------------- flushing

  function takeBatch() {
    const batch = { kinds: new Set(pending.kinds), work: [...pending.work], known: [...pending.known] };
    pending.kinds.clear();
    pending.work.clear();
    pending.known.clear();
    for (const l of Object.values(lanes)) l.first = null;
    return batch;
  }

  /** A batch that raced a pause goes back into pending (paths kept), for the resume to emit. */
  function mergeBack(kinds, paths) {
    for (const k of kinds) pending.kinds.add(k);
    if (paths === null) goBlind();
    else if (!blindStatus()) for (const p of paths) pending.known.add(p);
    if (pending.work.size + pending.known.size > MAX_CHECK) goBlind();
  }

  /** The event for a filtered batch, or null when only ignored files changed. */
  function toEvent(kinds, paths) {
    if (kinds.has('full')) return { kinds: ['full'] };
    const k = new Set(kinds);
    if (paths === null || paths.length) k.add('status');
    if (!k.size) return null;
    const e = { kinds: [...k].sort() }; // NOSONAR(S2871): kind names; code-unit order is intended
    if (paths && paths.length && paths.length <= MAX_PATHS) e.paths = paths;
    return e;
  }

  function deliver({ kinds, work }, paths, epoch) {
    if (closed) return;
    // A .gitignore that isn't itself ignored changed (unfiltered batch: assume it matters).
    if ((paths === null || kinds.has('full') ? work : paths).some(isRuleFile)) rulesChanged();
    if (epoch !== pauseEpoch) {
      mergeBack(kinds, paths); // paused (and maybe resumed) meanwhile: the resume emits one batch
      flushAgain = true;
      return;
    }
    if (!fs.existsSync(rootAbs)) {
      gone();
      return;
    }
    const e = toEvent(kinds, paths);
    if (e) onEvent(e);
  }

  /** Emit everything pending (after filtering working-folder paths), unless paused or closed. */
  function flush() {
    if (closed || pauses > 0) return;
    clearTimers();
    if (flushing) {
      flushAgain = true;
      return;
    }
    if (!pending.kinds.size && !pending.work.size && !pending.known.size) return;
    const batch = takeBatch();
    const epoch = pauseEpoch;
    flushing = true;
    resolvePaths(batch)
      .catch((err) => {
        log('could not filter changes (refreshing status):', err);
        return null; // never lose a batch: a blind status
      })
      .then((paths) => deliver(batch, paths, epoch))
      .catch((err) => log('could not deliver changes:', err))
      .finally(() => {
        flushing = false;
        if (flushAgain) {
          flushAgain = false;
          flush();
        }
      });
  }

  // ---------------------------------------------------------------- lifecycle

  function close() {
    if (closed) return;
    closed = true;
    clearTimers();
    pending.kinds.clear();
    pending.work.clear();
    pending.known.clear();
    for (const w of watchers.splice(0)) w.close();
  }

  function gone() {
    close();
    onEvent({ kinds: ['gone'] });
  }

  /** A watch failed: stop everything and report once (no retry: the caller decides when). */
  function fail(error) {
    if (closed) return;
    const missing = !fs.existsSync(rootAbs);
    close();
    // Deferred: fail() can run inside createWatcher, before the caller has the handle.
    queueMicrotask(() => onEvent(missing ? { kinds: ['gone'] } : { kinds: ['error'], error }));
  }

  function watch(base) {
    if (closed) return;
    const opts = linux ? { recursive: true, ignore: (rel) => skipWatch(path.resolve(base, rel)) } : { recursive: true };
    starting = true;
    try {
      const w = fsWatch(base, opts, (_type, name) => onFsEvent(base, name));
      w.on('error', fail);
      watchers.push(w);
    } catch (err) {
      fail(err); // ENOENT (root gone), EMFILE, ENOSPC (inotify limit), EPERM...
    } finally {
      starting = false;
    }
  }

  /** The gitdir and common dir, as absolute real paths. */
  async function gitDirs() {
    if (bare) return { git: rootAbs, common: rootAbs };
    if (gitDir) {
      const g = realpath(path.resolve(rootAbs, gitDir));
      return { git: g, common: g };
    }
    const [g, c] = (await out(rootAbs, ['rev-parse', '--git-dir', '--git-common-dir'])).split('\n');
    return { git: realpath(path.resolve(rootAbs, g)), common: realpath(path.resolve(rootAbs, c || g)) };
  }

  // Linux waits for the gitdirs and the ignored entries, so the walk can skip them; elsewhere the
  // root is watched right away.
  if (!linux) watch(rootAbs);
  const ready = gitDirs().then(async (d) => {
    if (closed) return;
    Object.assign(dirs, d);
    if (linux) {
      await loadSkipEntries();
      watch(rootAbs);
    }
    // The common dir first: a linked worktree's gitdir usually lives inside it (worktrees/<name>).
    const bases = [];
    for (const dir of [d.common, d.git]) {
      if (!inside(dir, rootAbs) && !bases.some((b) => inside(dir, b))) bases.push(dir);
    }
    for (const b of bases) watch(b);
  }).catch(fail);

  return {
    ready,
    pause() {
      if (closed) return;
      pauses++;
      pauseEpoch++;
      clearTimers();
    },
    resume() {
      if (closed || pauses === 0) return;
      pauses--;
      if (pauses > 0) return;
      graceUntil = clock.now() + resumeGrace;
      flush();
    },
    close,
  };
}

module.exports = { createWatcher, classify, noisyGit, MAX_CHECK, MAX_PATHS };
