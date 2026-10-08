'use strict';
// The working tree's own state, with no knowledge of rebases, merges or our autostash: what
// `status --porcelain=v2 --branch` says plus the operation in progress (repo-dirs.repoState).
// Modules below the status aggregate (src/status.js) read this one: stash.js to know whether
// there is anything to stash or whether an operation left conflicts.
const { out } = require('./exec');
const { repoState } = require('./repo-dirs');
const { parsePorcelainV2 } = require('./porcelain');

/**
 * The status command every read uses (rename detection, untracked files one by one). A
 * submodule shows only when its checked-out commit differs (`--ignore-submodules=dirty`): changes
 * inside one would need a status run in the submodule, with its own config and hooks. On the
 * command line, since a repo's .gitmodules can override diff.ignoreSubmodules per submodule.
 */
const STATUS_ARGS = Object.freeze(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--renames', '--ignore-submodules=dirty']);

/**
 * {branch, oid, upstream, ahead, behind, staged, unstaged, conflicted, state} of the worktree
 * containing `cwd` (not a bare repository: `git status` needs a working tree).
 * - `staged` / `unstaged`: [{path, status, orig?}] (`orig`: a rename's or copy's source; '?' is
 *   an untracked file, in `unstaged`);
 * - `conflicted`: [{path, status: 'U', xy}], `xy` the porcelain v2 XY of the unmerged entry
 *   ('UU' both modified, 'AA' both added, 'UD' / 'DU' deleted by them / us, 'AU', 'UA', 'DD');
 * - `state`: repo-dirs.repoState ('clean', 'rebasing', 'merging', ...).
 */
async function workingState(cwd) {
  const [raw, state] = await Promise.all([out(cwd, STATUS_ARGS), repoState(cwd)]);
  return parsePorcelainV2(raw, {
    branch: null, oid: null, upstream: null, ahead: 0, behind: 0, staged: [], unstaged: [], conflicted: [], state,
  });
}

/** True when `st` (a workingState or status) has changes to stash: staged, unstaged or untracked. */
const hasChanges = (st) => st.staged.length > 0 || st.unstaged.length > 0;

module.exports = { STATUS_ARGS, workingState, hasChanges };
