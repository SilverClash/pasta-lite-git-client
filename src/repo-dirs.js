'use strict';
// Where a repository is: the worktree root a command runs in (resolveRoot), a bare repo's git
// dir (bareGitDir, isBare), a worktree's own and common git dirs (repoDirs, gitDir), and the
// caches behind them; plus the two facts of the checked-out state every module asks: HEAD
// (headState) and the operation in progress (repoState). Commands here run through
// src/git-process.js directly, in the folder they were given: exec.run builds on resolveRoot.
const fs = require('node:fs');
const path = require('node:path');
const { gitAt, tryGitAt, GitError } = require('./git-process');
const { branchOf } = require('./gitref');
const { nativePath, samePath } = require('./fs-paths');

// Every command runs at the worktree root, so root-relative paths from `status` are valid
// pathspecs no matter which subdirectory the caller passed. Bare repos, a .git folder and
// non-repos (where --show-toplevel fails) keep cwd.
// Only roots are cached (root -> root): a subdirectory can later become a repo of its own
// (`git init` inside it), so its answer is asked again every time. A bare repo's git dir (the
// "root" ops.openRepo gives a bare repo) is cached in bareRoots once bareGitDir has seen
// git call it bare, so its commands skip the failing --show-toplevel. A .git folder and a
// non-repo are never cached. A folder can change what it is (a bare repo deleted and a normal one
// made in its place, a repo converted to the bare + worktrees layout): ops.openRepo forgets the
// entries of what it opens first (forgetRoot), and ops.summary asks isBare fresh.
const rootCache = new Set();
const bareRoots = new Set();

/** Forget everything cached about the folder `dir` (a worktree root, a bare git dir, its git dirs). */
function forgetRoot(dir) {
  const abs = path.resolve(dir);
  rootCache.delete(abs);
  bareRoots.delete(abs);
  dirsCache.delete(abs);
}

/**
 * The worktree root containing `cwd` (a cached root, or a bare repo's git dir, as is), or `cwd`
 * itself when it has none: a bare repo, a .git folder or a non-repo (--show-toplevel fails).
 * git's answer is in native spelling (fs-paths.nativePath: Git for Windows prints 'C:/x'); `cwd`
 * is the root when it is that folder in any spelling samePath accepts (on Windows, any case), and
 * is then cached and returned as given.
 */
async function resolveRoot(cwd) {
  const abs = path.resolve(cwd);
  if (rootCache.has(abs) || bareRoots.has(abs)) return abs;
  const printed = await gitAt(abs, ['rev-parse', '--show-toplevel']).then((r) => r.stdout.trim(), () => null);
  if (!printed) return abs; // not (yet) a repo or no worktree: `git init` may follow
  const top = nativePath(printed);
  if (!samePath(top, abs)) return top;
  rootCache.add(abs);
  return abs;
}

/**
 * {bare, gitDir} of the repository `dir` is in (any folder: a bare git dir or a subfolder of one,
 * a folder whose `.git` file points at a bare repo, a worktree). `bare`: git calls the repository
 * bare (`rev-parse --is-bare-repository`: no working tree); `gitDir` is its absolute git dir, for
 * a bare repo the folder every command then runs in. A bare git dir is remembered (bareRoots).
 * Throws git's GitError when `dir` is in no repository (128), or when git refuses the repo
 * (safe.bareRepository=explicit: "cannot use bare repository"; dubious ownership).
 */
async function bareGitDir(dir) {
  const abs = path.resolve(dir);
  const { stdout } = await gitAt(abs, ['rev-parse', '--is-bare-repository', '--absolute-git-dir']);
  const [flag, gitDirPath] = stdout.split('\n');
  const bare = flag === 'true';
  // nativePath: Git for Windows prints 'C:/x/.bare', every lookup is spelled 'C:\\x\\.bare'.
  const gitDir = gitDirPath ? nativePath(gitDirPath) : abs;
  if (bare && gitDirPath) bareRoots.add(gitDir);
  return { bare, gitDir };
}

/**
 * True when `cwd` is inside a bare repository (no working tree). Cached: a worktree root
 * (resolveRoot's cache) is never bare, a bare git dir (bareRoots) always is; anything else asks
 * git (false when it fails or the folder is missing: not a repo at all). The runner's gate (src/ops.js) asks this per
 * op outside ops.BARE_OK, so on a normal repo it costs nothing after the first command.
 * `fresh` (ops.summary): the caches are not trusted but corrected: a folder that is no longer a
 * bare repo leaves bareRoots, one that became one leaves rootCache.
 */
async function isBare(cwd, { fresh = false } = {}) {
  const abs = path.resolve(cwd);
  if (fresh) {
    const bare = await askBare(abs);
    // What was cached says otherwise: the folder changed, and so did its git dirs (bareGitDir
    // has recorded a bare one again).
    if (bare ? rootCache.delete(abs) : bareRoots.delete(abs)) dirsCache.delete(abs);
    return bare;
  }
  if (bareRoots.has(abs)) return true;
  if (rootCache.has(abs)) return false;
  return askBare(abs);
}

/** isBare without the caches (bareGitDir still records a bare git dir it sees). */
async function askBare(abs) {
  // A missing folder is no repository (and git can't even start there: ENOENT, as for no git).
  if (!fs.statSync(abs, { throwIfNoEntry: false })?.isDirectory()) return false;
  // A worktree root has a `.git` entry (folder or file); a bare git dir never does (the layout's
  // `top` has one, but a bare repo's root is its git dir, never `top`). No git process for the
  // common case: the runner asks this before a normal repo's first write.
  if (fs.lstatSync(path.join(abs, '.git'), { throwIfNoEntry: false })) return false;
  try {
    return (await bareGitDir(abs)).bare;
  } catch (e) {
    if (e instanceof GitError) return false;
    throw e;
  }
}

/** { sha: HEAD commit or null (unborn), branch: short branch name or null (detached) }. */
async function headState(cwd) {
  const root = await resolveRoot(cwd);
  const [sha, ref] = await Promise.all([
    tryGitAt(root, ['rev-parse', '-q', '--verify', 'HEAD^{commit}']),
    tryGitAt(root, ['symbolic-ref', '-q', 'HEAD']),
  ]);
  return { sha: sha ? sha.trim() : null, branch: ref ? branchOf(ref.trim()) : null };
}

const STATE_FILES = [
  // [git-path, state]; first existing wins
  ['rebase-merge', 'rebasing'],
  ['rebase-apply/applying', 'am'],
  ['rebase-apply', 'rebasing'],
  ['MERGE_HEAD', 'merging'],
  ['CHERRY_PICK_HEAD', 'cherry-picking'],
  ['REVERT_HEAD', 'reverting'],
  ['sequencer', 'sequencer'],
  ['BISECT_LOG', 'bisecting'],
];

/**
 * 'clean' or the in-progress operation: rebasing | am | merging | cherry-picking | reverting |
 * sequencer | bisecting. Every file it looks for is per worktree, so it lives in the git dir.
 */
async function repoState(cwd) {
  return stateAt(await gitDir(cwd));
}

/** repoState for the git dir `gd` itself (a linked worktree's admin folder), from the file system only. */
function stateAt(gd) {
  for (const [p, state] of STATE_FILES) {
    if (fs.existsSync(path.join(gd, p))) return state;
  }
  return 'clean';
}

// root -> {gitDir, commonDir}. A worktree's git dir doesn't move, so it is asked once per root;
// an entry whose git dir is gone (the repo was deleted, a worktree removed) is asked again.
const dirsCache = new Map();

/**
 * {gitDir, commonDir} of the worktree containing `cwd`, both absolute: its own git dir (a linked
 * worktree's `.git/worktrees/x`) and the common dir every worktree shares (`.git`).
 */
async function repoDirs(cwd) {
  const root = await resolveRoot(cwd);
  const hit = dirsCache.get(root);
  if (hit && fs.statSync(hit.gitDir, { throwIfNoEntry: false })?.isDirectory()) return hit;
  const [gd, common] = (await gitAt(root, ['rev-parse', '--absolute-git-dir', '--path-format=absolute', '--git-common-dir'])).stdout.split('\n').map((p) => nativePath(p));
  const dirs = { gitDir: gd, commonDir: common || gd };
  dirsCache.set(root, dirs);
  return dirs;
}

/** Absolute git dir of the worktree containing `cwd` (a linked worktree's own `.git/worktrees/x`). */
async function gitDir(cwd) {
  return (await repoDirs(cwd)).gitDir;
}

module.exports = {
  resolveRoot, forgetRoot, bareGitDir, isBare, repoDirs, gitDir, headState, repoState, stateAt,
  _internal: { STATE_FILES }, // exported for unit tests only
};
