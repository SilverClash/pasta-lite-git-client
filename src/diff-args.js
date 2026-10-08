'use strict';
// The one builder of the diff commands whose patches the UI shows and hunks.js indexes. The
// displayed patch must be byte-for-byte the one a hunk or line action works on (the staging
// fingerprint of the shown diff is checked against it), so
// git.diffWorkdir / git.diffCommitFile and hunks.js all take their argv and options from here.
const { DIFF_OPTS, LITERAL_ENV } = require('./exec');

// Literal pathspecs, the diff config overrides (exec's DIFF_ARGS), and latin1 so each byte is one
// char: non-UTF-8 content round-trips exactly.
const DIFF_RUN = Object.freeze({ env: LITERAL_ENV, diff: true, encoding: 'latin1' });

// A submodule's diff is its commit change only, never changes inside it (which would run git in
// the submodule, with its own config and hooks). On the command line: a repo's .gitmodules can
// override diff.ignoreSubmodules per submodule.
const NO_SUBMODULE_WORKTREE = '--ignore-submodules=dirty';

/**
 * {args, opts} of the patch of one working-tree file: index -> worktree, HEAD -> index (`staged`;
 * against the empty tree in an unborn repo), /dev/null -> file (`untracked`; exit code 1 is a
 * diff), or with `orig` (a rename's source, differing from `file`) both paths with rename
 * detection (-M), which hunks.js never indexes.
 */
function workdirDiff(file, { staged = false, untracked = false, orig } = {}) {
  if (untracked) return { args: ['diff', '--no-index', ...DIFF_OPTS, '--', '/dev/null', file], opts: { ...DIFF_RUN, okCodes: [0, 1] } };
  const tracked = ['diff', ...(staged ? ['--cached'] : []), NO_SUBMODULE_WORKTREE];
  if (orig !== undefined && orig !== file) {
    return { args: [...tracked, '-M', ...DIFF_OPTS, '--', orig, file], opts: DIFF_RUN };
  }
  return { args: [...tracked, ...DIFF_OPTS, '--', file], opts: DIFF_RUN };
}

/** {args, opts} of the patch of `paths` in commit `sha` against `base` (renames detected with -M). */
const commitDiff = (base, sha, paths) => ({ args: ['diff', ...DIFF_OPTS, '-M', base, sha, '--', ...paths], opts: DIFF_RUN });

module.exports = { DIFF_RUN, workdirDiff, commitDiff };
