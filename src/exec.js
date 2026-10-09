'use strict';
// The git runner every module uses: run / out / tryOut run `git <GLOBAL_ARGS> <args>` at the
// worktree root containing `cwd` (src/repo-dirs.js finds it; a bare repo's git dir, a .git
// folder or a non-repo keep cwd), so root-relative paths from `status` are valid pathspecs
// whatever subdirectory a caller passes. The process itself (env allowlist, timeouts,
// cancellation, byte-safe output, killing on quit) is src/git-process.js. This module re-exports
// that one and the repository-location helpers of repo-dirs.js, so a caller needs one require.
// Also here: the two commands that take paths on argv in chunks (lsUntracked, cleanFiles).
const proc = require('./git-process');
const dirs = require('./repo-dirs');

const { gitAt, GitError, argvChunks, LITERAL_ENV } = proc;

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

const UNTRACKED = ['ls-files', '-z', '--others', '--exclude-standard', '--'];
const CLEAN = ['clean', '-f', '-q', '--'];

/**
 * The untracked, not ignored files under `paths` (root-relative files or directories, taken
 * literally), as a Set of root-relative paths. ls-files has no --pathspec-from-file, so the paths
 * go on argv in argvChunks (a Windows command line holds 32,767 characters); a file two chunks
 * list (a directory and a path inside it) counts once. `env` is added to LITERAL_ENV (e.g. a temp
 * GIT_INDEX_FILE); `platform` for tests.
 * @param {{env?: object, platform?: string}} [o]
 */
async function lsUntracked(cwd, paths, { env, platform } = {}) {
  const files = new Set();
  for (const chunk of argvChunks(paths, { prefix: UNTRACKED, platform })) {
    const raw = await out(cwd, [...UNTRACKED, ...chunk], { env: { ...LITERAL_ENV, ...env } });
    for (const f of raw.split('\0')) if (f) files.add(f);
  }
  return files;
}

/**
 * `git clean -f -q` of the files `paths` (root-relative, taken literally), in argvChunks: clean
 * has no --pathspec-from-file either. Options as lsUntracked.
 * @param {{env?: object, platform?: string}} [o]
 */
async function cleanFiles(cwd, paths, { env, platform } = {}) {
  for (const chunk of argvChunks(paths, { prefix: CLEAN, platform })) {
    await run(cwd, [...CLEAN, ...chunk], { env: { ...LITERAL_ENV, ...env } });
  }
}

module.exports = {
  run, out, tryOut, lsUntracked, cleanFiles,
  // src/git-process.js
  setGitBinary: proc.setGitBinary, withSignal: proc.withSignal, killChildren: proc.killChildren, MAX_OUTPUT_BYTES: proc.MAX_OUTPUT_BYTES,
  GitError, kindError: proc.kindError, tagError: proc.tagError, abortedError: proc.abortedError, nulList: proc.nulList, DIFF_OPTS: proc.DIFF_OPTS, LITERAL_ENV,
  // src/repo-dirs.js
  resolveRoot: dirs.resolveRoot, forgetRoot: dirs.forgetRoot, bareGitDir: dirs.bareGitDir, isBare: dirs.isBare,
  headState: dirs.headState, repoState: dirs.repoState, stateAt: dirs.stateAt, gitDir: dirs.gitDir, repoDirs: dirs.repoDirs,
};
