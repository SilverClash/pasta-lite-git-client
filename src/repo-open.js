'use strict';
// Opening a repository: which folder a path the user picked stands for (a
// worktree root, or a bare repo's git dir), the refusals (not-found, not-a-repo, unsafe-repo,
// embedded-bare), and the {root, name, head, bare, linkedWorktree} summary main.js shows (the
// tab strip, the window title and the page's header read linkedWorktree: whether the folder is a
// linked worktree, decided here from git's dirs so the renderer never compares paths). Split out of
// ops.js, which re-exports openRepo / summary / repoName.
const fs = require('node:fs');
const path = require('node:path');
const { kindError, tagError, tryOut, GitError } = require('./exec');
const { forgetRoot, gitDirKey, bareGitDir, isBare, headState, repoDirs } = require('./repo-dirs');
const { parseWorktrees } = require('./porcelain');
const gitErrors = require('./git-errors');
const git = require('./git');

/**
 * Resolve the worktree root of `dir` (any subdirectory): {root, name, head: {sha, branch}, bare}.
 * A bare repository opens too: `dir` is its git dir, a folder in it, or a folder whose
 * `.git` file points at it (the "bare + worktrees" layout: top/.git = 'gitdir: ./.bare'); root is
 * then the bare git dir and bare is true. A linked worktree of it opens as any worktree.
 * Errors: kind 'not-found' (no such folder), 'not-a-repo' (not inside a worktree or a bare repo:
 * a normal repo's .git folder is not bare, so it stays not-a-repo; git refusing a bare repo under
 * safe.bareRepository=explicit gives git's message), 'unsafe-repo' (git refuses it: dubious
 * ownership; message is git's, with its safe.directory hint), 'embedded-bare' (a bare repo inside
 * another repo's worktree: see bareRoot). Anything else is passed through unchanged. Callers
 * should forget a recent entry only for 'not-found' / 'not-a-repo'.
 * What exec cached about the folder (and then its root) is forgotten first: it may have become
 * something else since (a bare repo replaced by a normal one, or the other way round).
 */
async function openRepo(dir) {
  if (typeof dir !== 'string' || !dir) throw kindError('not-a-repo', 'No folder given');
  const abs = path.resolve(dir);
  let st;
  try {
    st = fs.statSync(abs);
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') throw kindError('not-found', `Folder not found: ${dir}`);
    throw e;
  }
  if (!st.isDirectory()) throw kindError('not-a-repo', `Not a folder: ${dir}`);
  forgetRoot(abs);
  let root;
  try {
    root = await git.root(abs);
  } catch (err) {
    if (err instanceof GitError && err.exitCode === 128) {
      if (gitErrors.matches(err, 'dubiousOwnership')) throw tagError(err, 'unsafe-repo');
      if (gitErrors.matches(err, 'notARepo')) return summary(await bareRoot(abs, dir));
    }
    throw err;
  }
  // A subfolder's root (git just found it): its entries may be as stale as the folder's were.
  if (path.resolve(root) !== abs) forgetRoot(root);
  return summary(root);
}

/**
 * The git dir of the bare repository `abs` is in (openRepo, once --show-toplevel failed), else
 * kind 'not-a-repo'. Every later command runs in that git dir, so it must be usable on its own:
 * under safe.bareRepository=explicit git accepts `top` (its .git file names the repo explicitly)
 * but refuses the bare dir itself, and that refusal (git's message) is the not-a-repo message.
 * A bare repo inside another repo's worktree is refused too (kind 'embedded-bare'): a project can
 * track one (HEAD, config, refs/, objects/ and an executable hooks/reference-transaction), and
 * opening it from the clone would run that hook on the first fetch. Its parent folder then has a
 * worktree whose git dir is another one. The bare + worktrees layout still opens: `top`, the
 * parent of `top/.bare`, belongs to the bare repo itself (git finds no worktree there).
 */
async function bareRoot(abs, dir) {
  const notARepo = (err) => {
    if (err instanceof GitError && err.exitCode === 128) {
      if (gitErrors.matches(err, 'dubiousOwnership')) return tagError(err, 'unsafe-repo');
      return kindError('not-a-repo', gitErrors.matches(err, 'bareRefused') ? err.message : `Not a git repository: ${dir}`);
    }
    return err;
  };
  let found;
  try {
    found = await bareGitDir(abs);
    if (!found.bare) throw kindError('not-a-repo', `Not a git repository: ${dir}`);
    if (found.gitDir !== abs) await bareGitDir(found.gitDir);
  } catch (err) {
    throw notARepo(err);
  }
  const outer = await tryOut(path.dirname(found.gitDir), ['rev-parse', '--show-toplevel', '--absolute-git-dir']);
  if (outer) {
    const [top, outerGitDir] = outer.split('\n');
    if (outerGitDir && gitDirKey(outerGitDir) !== found.gitDir) {
      forgetRoot(found.gitDir);
      throw kindError('embedded-bare', `Not opened: ${dir} is a bare repository inside the working tree of ${top}. A project can ship one to run its hooks; open ${top} instead.`);
    }
  }
  return found.gitDir;
}

/**
 * Name shown for a repo (tab title, recent list, toolbar): the root's basename. A bare git dir
 * with a hidden name ('.bare' in the bare + worktrees layout) is shown with its parent folder,
 * 'project/.bare', so it says which project it is.
 */
function repoName(root, bare) {
  const base = path.basename(root);
  return bare && base.startsWith('.') ? `${path.basename(path.dirname(root))}/${base}` : base;
}

/**
 * The project a linked worktree belongs to, by its main worktree `mainPath` (bare: the bare git
 * dir): its folder name, or for a hidden bare git dir ('.bare' of the bare + worktrees layout) its
 * parent's, so a tab reads 'project · feat' rather than 'project/.bare · feat'.
 */
function projectName(mainPath, bare) {
  const base = path.basename(mainPath);
  return bare && base.startsWith('.') ? path.basename(path.dirname(mainPath)) : base;
}

// How long the `worktree list` fallback of mainWorktreeOf may take: git stats every listed worktree,
// and one on a hung network volume must not hold up an open (it falls back to git's own guess).
const LIST_TIMEOUT_MS = 5000;

/**
 * linkedWorktree of summary(): null for a main worktree (its git dir is the common dir), a bare repo,
 * a submodule or a folder git can't answer for; for a linked worktree {mainPath, mainName, title}:
 * mainPath its main worktree (mainWorktreeOf; a bare repo's git dir when the main one is bare),
 * mainName its projectName, title what the tab strip and the window title show,
 * '<mainName> · <worktree folder name>'.
 * Cheap on every open and app:getState: a linked worktree's root always has a `.git` *file*, so a
 * root with a `.git` folder (a main worktree) or none (a bare repo) runs no git at all; else the
 * repo's git dirs (repoDirs, cached per root) decide. A failed lookup (any GitError, a timeout or a
 * cancellation included) never fails the open: no git dirs give null, no main worktree git's guess.
 */
async function linkedWorktreeOf(root) {
  let dotGit;
  try {
    dotGit = fs.lstatSync(path.join(root, '.git'), { throwIfNoEntry: false });
  } catch {
    return null;
  }
  if (!dotGit || !dotGit.isFile()) return null;
  let dirs;
  try {
    dirs = await repoDirs(root);
  } catch (err) {
    if (err instanceof GitError) return null;
    throw err;
  }
  if (!dirs.gitDir || gitDirKey(dirs.gitDir) === gitDirKey(dirs.commonDir)) return null;
  const { path: mainPath, bare: mainBare } = await mainWorktreeOf(root, gitDirKey(dirs.commonDir));
  const mainName = projectName(mainPath, mainBare);
  return { mainPath, mainName, title: `${mainName} · ${path.basename(root)}` };
}

/**
 * {path, bare} of the main worktree of linked worktree `root`, whose common git dir is `common`:
 * - common is a `.git` folder: its parent (what `git worktree list` prints first, with no process);
 * - else core.worktree of the common dir, relative to it: a submodule's `sup/.git/modules/sub`
 *   names its worktree `sup/sub` there, while `worktree list` would print the modules dir;
 * - else `worktree list`'s first entry (the bare + worktrees layout: the bare git dir), bounded by
 *   LIST_TIMEOUT_MS; when git fails, git's own guess: the common dir itself, bare.
 */
async function mainWorktreeOf(root, common) {
  if (path.basename(common) === '.git') return { path: path.dirname(common), bare: false };
  const quiet = (p) => p.catch((err) => {
    if (err instanceof GitError) return null;
    throw err;
  });
  const wt = await quiet(tryOut(root, ['config', '--file', path.join(common, 'config'), '--get', 'core.worktree']));
  if (wt && wt.trim()) return { path: path.resolve(common, wt.replace(/\r?\n$/, '')), bare: false };
  const raw = await quiet(tryOut(root, ['worktree', 'list', '--porcelain', '-z'], { timeout: LIST_TIMEOUT_MS }));
  const main = raw ? parseWorktrees(raw)[0] : null;
  return main && main.path ? { path: main.path, bare: !!main.bare } : { path: common, bare: true };
}

/**
 * {root, name, head, bare, linkedWorktree} of an already resolved root (a worktree root or a bare
 * git dir). `bare` is asked fresh (app:getState calls this): the folder may have changed since exec
 * cached it. linkedWorktree: see linkedWorktreeOf (null unless `root` is a linked worktree), looked
 * up alongside head and bare.
 */
async function summary(root) {
  const [head, bare, linked] = await Promise.all([headState(root), isBare(root, { fresh: true }), linkedWorktreeOf(root)]);
  return { root, name: repoName(root, bare), head, bare, linkedWorktree: bare ? null : linked };
}

module.exports = { openRepo, bareRoot, summary, repoName, projectName, linkedWorktreeOf };
