'use strict';
// The git runner every module uses: run / out / tryOut run `git <GLOBAL_ARGS> <args>` at the
// worktree root containing `cwd` (src/repo-dirs.js finds it; a bare repo's git dir, a .git
// folder or a non-repo keep cwd), so root-relative paths from `status` are valid pathspecs
// whatever subdirectory a caller passes. The process itself (env allowlist, timeouts,
// cancellation, byte-safe output, killing on quit) is src/git-process.js. This module re-exports
// that one and the repository-location helpers of repo-dirs.js, so a caller needs one require.
const proc = require('./git-process');
const dirs = require('./repo-dirs');

const { gitAt, GitError } = proc;

/**
 * Run git at the worktree root containing `cwd`.
 * @param {string} cwd
 * @param {string[]} args
 * @param {{input?: string|Buffer, env?: object, okCodes?: number[], diff?: boolean,
 *          encoding?: 'utf8'|'latin1'|'buffer', timeout?: number, signal?: AbortSignal,
 *          maxBytes?: number}} [opts]
 *   encoding 'latin1' round-trips arbitrary bytes 1:1 through a JS string; 'buffer' returns a Buffer.
 *   maxBytes caps stdout + stderr (default MAX_OUTPUT_BYTES); beyond it git is killed and the
 *   call rejects with kind 'too-large'.
 * @returns {Promise<{stdout: string|Buffer, stderr: string, code: number}>}
 */
async function run(cwd, args, opts = {}) {
  return gitAt(await dirs.resolveRoot(cwd), args, opts);
}

/** run() and return stdout only. */
const out = async (cwd, args, opts) => (await run(cwd, args, opts)).stdout;

/**
 * out(), or null when git fails (GitError). Cancellation, timeouts, 'too-large' and other errors
 * (e.g. git missing) propagate.
 */
async function tryOut(cwd, args, opts) {
  try {
    return await out(cwd, args, opts);
  } catch (e) {
    if (e instanceof GitError && !e.kind) return null;
    throw e;
  }
}

module.exports = {
  run, out, tryOut,
  // src/git-process.js
  setGitBinary: proc.setGitBinary, withSignal: proc.withSignal, killChildren: proc.killChildren, MAX_OUTPUT_BYTES: proc.MAX_OUTPUT_BYTES,
  GitError, kindError: proc.kindError, tagError: proc.tagError, nulList: proc.nulList, argvChunks: proc.argvChunks, DIFF_OPTS: proc.DIFF_OPTS, LITERAL_ENV: proc.LITERAL_ENV,
  // src/repo-dirs.js
  resolveRoot: dirs.resolveRoot, forgetRoot: dirs.forgetRoot, gitDirKey: dirs.gitDirKey, bareGitDir: dirs.bareGitDir, isBare: dirs.isBare,
  headState: dirs.headState, repoState: dirs.repoState, stateAt: dirs.stateAt, gitDir: dirs.gitDir, repoDirs: dirs.repoDirs,
};
