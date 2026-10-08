'use strict';
// Small read-only lookups the git modules share (they run git but never change the repo): object
// ids and refs, ancestry, remotes and upstreams. Below git.js, so that the modules git.js builds on
// (status, remote, pull, stash, rebase) can use them too; git.js re-exports them.
const { run, out, tryOut } = require('./exec');
const { headState } = require('./repo-dirs');
const { fullBranch } = require('./gitref');

/** The repository's object format: 'sha1' or 'sha256' ('sha1' when git can't say). */
async function objectFormat(cwd) {
  return ((await tryOut(cwd, ['rev-parse', '--show-object-format'])) || 'sha1').trim() || 'sha1';
}

/** The all-zero object id of the repository's object format (git's "no object"). */
const zeroOid = async (cwd) => '0'.repeat((await objectFormat(cwd)) === 'sha256' ? 64 : 40);

const emptyTreeCache = new Map();

/** The empty tree's id in the repository's object format (sha1 and sha256 ids differ). */
async function emptyTree(cwd) {
  const fmt = await objectFormat(cwd);
  if (!emptyTreeCache.has(fmt)) {
    emptyTreeCache.set(fmt, (await out(cwd, ['hash-object', '-t', 'tree', '--stdin'], { input: '' })).trim());
  }
  return emptyTreeCache.get(fmt);
}

/** First parent of `sha`, or the empty tree for a root commit (the base its diff is shown against). */
async function baseOf(cwd, sha) {
  return (await verify(cwd, `${sha}^1`)) || emptyTree(cwd);
}

/**
 * Object id `rev` (any revision: name, sha, 'refs/stash@{1}', 'HEAD~1') resolves to, or null.
 * `commit`: peel it to a commit (null when it isn't one). Never read as an option.
 */
async function verify(cwd, rev, { commit = false } = {}) {
  if (typeof rev !== 'string' || !rev || rev.startsWith('-')) return null;
  const raw = await tryOut(cwd, ['rev-parse', '-q', '--verify', '--end-of-options', commit ? `${rev}^{commit}` : rev]);
  return raw ? raw.trim() || null : null;
}

/** True when the full ref name `ref` (e.g. 'refs/heads/x') exists exactly (no DWIM, no @{...}). */
async function refExists(cwd, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('refs/')) return false;
  return (await tryOut(cwd, ['show-ref', '--verify', '--quiet', ref])) !== null;
}

/** Commit id `rev` (any revision: name, sha, 'HEAD~1') resolves to, or null. Never an option. */
const resolveCommit = (cwd, rev) => verify(cwd, rev, { commit: true });

/** True when commit `a` is an ancestor of (or equal to) commit `b`. Both are full object ids. */
async function isAncestor(cwd, a, b) {
  return (await run(cwd, ['merge-base', '--is-ancestor', a, b], { okCodes: [0, 1] })).code === 0;
}

async function remotes(cwd) {
  return (await out(cwd, ['remote'])).split('\n').filter(Boolean);
}

/**
 * `fields` (for-each-ref atoms) of exactly the ref `fullRef`, or null when it doesn't exist.
 * for-each-ref also matches `fullRef` as a prefix up to a slash ('refs/heads/feat' lists
 * 'refs/heads/feat/a'), so rows are filtered by their refname.
 */
async function refFields(cwd, fullRef, fields) {
  const raw = await out(cwd, ['for-each-ref', `--format=${['%(refname)', ...fields].join('%00')}`, fullRef]);
  for (const line of raw.split('\n')) {
    const [ref, ...rest] = line.split('\0');
    if (ref === fullRef) return rest;
  }
  return null;
}

/** Upstream of a local branch as {ref, remote, remoteRef} or null. */
async function upstreamOf(cwd, branch) {
  const row = await refFields(cwd, fullBranch(branch), ['%(upstream)', '%(upstream:remotename)', '%(upstream:remoteref)']);
  const [ref, remote, remoteRef] = row || [];
  return ref ? { ref, remote, remoteRef } : null;
}

/** True when `name` is the branch HEAD names (checked out here; in a bare repo, HEAD's branch). */
const isCurrentBranch = async (cwd, name) => (await headState(cwd)).branch === name;

/** Paths commit `commit` changes (vs its first parent; a root commit: all of its files). */
async function commitPaths(cwd, commit) {
  const raw = await out(cwd, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--no-renames', '--root', commit]);
  return raw.split('\0').filter(Boolean);
}

module.exports = {
  objectFormat, zeroOid, emptyTree, baseOf, verify, resolveCommit, refExists, isAncestor, isCurrentBranch, commitPaths,
  remotes, refFields, upstreamOf,
};
