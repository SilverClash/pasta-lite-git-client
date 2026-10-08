'use strict';
// Talking to remotes: fetch (never force-updating local tags), push with an explicit refspec,
// setting an upstream, and which remotes are mirrors whose fetch would rewrite local branches.
// git.js re-exports all of it.
const { kindError, tagError, run, out, tryOut } = require('./exec');
const { headState } = require('./repo-dirs');
const { verify, remotes, upstreamOf } = require('./git-reads');
const { PREFIX, after, branchOf, fullBranch, isRefspecSafe } = require('./gitref');
const gitErrors = require('./git-errors');
const { logger } = require('./log');

/** Default timeout for commands that talk to a remote (fetch / push). */
const REMOTE_TIMEOUT_MS = 120000;

/** Pass-through options for commands that talk to a remote. */
const remoteOpts = ({ signal, timeout = REMOTE_TIMEOUT_MS } = {}) => ({ timeout, signal });

function checkRemoteName(remote) {
  if (typeof remote !== 'string' || !remote || remote.startsWith('-')) throw kindError('invalid-args', `Invalid remote: '${remote}'`);
}

/**
 * True when fetching with refspec `spec` (a remote.<r>.fetch value) writes local branches: its
 * destination is under refs/heads/ or a pattern that covers it ('+refs/*:refs/*' of a mirror).
 * A destination not starting with refs/ is spelled the way git completes it (heads/x, tags/x,
 * remotes/x get refs/; anything else is a branch). Negative and destination-less refspecs write
 * no ref.
 */
function writesBranches(spec) {
  const s = String(spec).replace(/^\+/, '');
  const colon = s.indexOf(':');
  if (s.startsWith('^') || colon < 0 || colon === s.length - 1) return false;
  let dst = s.slice(colon + 1);
  if (!dst.startsWith('refs/')) dst = /^(heads|tags|remotes)\//.test(dst) ? `refs/${dst}` : `refs/heads/${dst}`;
  const star = dst.indexOf('*');
  if (star < 0) return dst.startsWith('refs/heads/');
  const prefix = dst.slice(0, star);
  return prefix.startsWith('refs/heads/') || 'refs/heads/'.startsWith(prefix);
}

/**
 * The remotes whose fetch would overwrite or delete local branches (a `git clone
 * --mirror` sets remote.<r>.mirror and '+refs/*:refs/*'): [{remote, why}], `why` the refspec
 * (or 'remote.<r>.mirror'). [] for an ordinary clone.
 */
async function mirrorRemotes(cwd) {
  const raw = await out(cwd, ['config', '-z', '--get-regexp', '^remote\\..+\\.(mirror|fetch)$'], { okCodes: [0, 1] });
  const found = new Map();
  for (const rec of raw.split('\0')) {
    const nl = rec.indexOf('\n');
    const key = nl < 0 ? rec : rec.slice(0, nl);
    const value = nl < 0 ? null : rec.slice(nl + 1); // null: a bare `mirror` line, which is true
    const m = /^remote\.(.+)\.(mirror|fetch)$/.exec(key);
    if (!m || found.has(m[1])) continue;
    if (m[2] === 'mirror' ? value === null || /^(true|yes|on|1)$/i.test(value) : writesBranches(value)) {
      found.set(m[1], m[2] === 'mirror' ? `remote.${m[1]}.mirror` : value);
    }
  }
  return [...found].map(([remote, why]) => ({ remote, why }));
}

/**
 * `fetch --prune --tags` one remote. Local tags that differ from the remote's are never
 * overwritten: git rejects them ("would clobber existing tag") and the whole fetch fails, so
 * we re-fetch with the remote's configured refspecs plus a negative refspec per conflicting
 * tag. Returns the conflicting tag names.
 */
async function fetchRemote(cwd, remote, opts, skipTags = []) {
  let refspecs = [];
  if (skipTags.length) {
    const configured = ((await tryOut(cwd, ['config', '--get-all', `remote.${remote}.fetch`])) || '').split('\n').filter(Boolean);
    // Negative refspecs alone fetch nothing: without configured ones, use git's clone default.
    const positive = configured.length ? configured : [`+refs/heads/*:refs/remotes/${remote}/*`];
    refspecs = [...positive, ...skipTags.map((t) => `^refs/tags/${t}`)];
  }
  try {
    // Never into submodules (their config and hooks are their own): on the command line, since
    // .gitmodules can turn fetch.recurseSubmodules back on per submodule.
    await run(cwd, ['fetch', '--porcelain', '--prune', '--tags', '--no-recurse-submodules', remote, ...refspecs], remoteOpts(opts));
    return skipTags;
  } catch (err) {
    // Credentials (the anchored patterns push uses), or "refusing to fetch into branch
    // 'refs/heads/x' checked out at '<path>'": the refspec writes local branches and a worktree
    // has that one checked out (git's message kept).
    const kind = gitErrors.kindFor(err, 'auth', 'checkedOutElsewhere');
    if (kind) throw tagError(err, kind);
    const rejected = gitErrors.unclassified(err) ? gitErrors.rejectedFetchRefs(err.stdout) : [];
    const tags = rejected.map((r) => after(r, PREFIX.TAGS)).filter((t) => t !== null);
    const next = [...new Set([...skipTags, ...tags])];
    if (!tags.length || tags.length !== rejected.length || next.length === skipTags.length) throw err;
    return fetchRemote(cwd, remote, opts, next);
  }
}

/**
 * Fetch `remote` (default: every remote) with --prune --tags, never force-updating local tags.
 * @param {{remote?: string, signal?: AbortSignal, timeout?: number}} [opts] timeout per remote,
 *   default REMOTE_TIMEOUT_MS; a timeout/abort throws kind 'timeout'/'aborted'.
 * @returns {Promise<{tagConflicts: string[]}>} local tags left alone because the remote's differ.
 * Credential failures throw kind 'auth' (as push does), so pull reports them the same way.
 */
async function fetch(cwd, { remote, signal, timeout } = {}) {
  if (remote !== undefined) checkRemoteName(remote);
  const names = remote !== undefined ? [remote] : await remotes(cwd);
  const tagConflicts = [];
  for (const name of names) tagConflicts.push(...(await fetchRemote(cwd, name, { signal, timeout })));
  return { tagConflicts: [...new Set(tagConflicts)] };
}

/**
 * Push a local branch with an explicit refspec. Target defaults to the branch's upstream;
 * `remoteBranch` overrides the remote branch name. `force`: false | 'lease' | truthy (plain).
 * Rejections throw kind rejected-behind | rejected-stale | rejected-hook (with remoteMessage)
 * | rejected | auth | timeout | aborted.
 */
async function push(cwd, { remote, branch, remoteBranch, force, signal, timeout } = {}) {
  for (const [what, v] of [['branch', branch], ['remoteBranch', remoteBranch]]) {
    if (v !== undefined && v !== null && !isRefspecSafe(v)) {
      throw kindError('invalid-args', `Invalid ${what}: '${v}'`);
    }
  }
  const local = branch || (await headState(cwd)).branch;
  if (!local) throw kindError('detached', 'Cannot push with a detached HEAD');
  const up = await upstreamOf(cwd, local);
  const upRemote = up && up.remote !== '.' ? up.remote : null;
  if (!remote && !upRemote) {
    throw kindError('no-upstream', `Branch '${local}' has no upstream`, { remotes: await remotes(cwd) });
  }
  const target = remote || upRemote;
  checkRemoteName(target);
  const dst = remoteBranch
    || (up && up.remote === target && branchOf(up.remoteRef) !== null ? branchOf(up.remoteRef) : local);
  let forceArgs = [];
  if (force === 'lease') {
    forceArgs = [`--force-with-lease=refs/heads/${dst}:${(await verify(cwd, `refs/remotes/${target}/${dst}`)) || ''}`];
  } else if (force) {
    forceArgs = ['--force'];
  }
  try {
    // --recurse-submodules=no: never checks or pushes submodules (fetch, above).
    await run(cwd, ['push', '--porcelain', '--recurse-submodules=no', ...forceArgs, target, `refs/heads/${local}:refs/heads/${dst}`], remoteOpts({ signal, timeout }));
  } catch (err) {
    const c = gitErrors.unclassified(err) && gitErrors.classifyPush(err);
    throw c ? tagError(err, c.kind, c.extra) : err;
  }
  return { remote: target, branch: local, remoteBranch: dst, forced: force || false };
}

/**
 * Make refs/remotes/<remote>/<remoteBranch> the upstream of `localBranch`, creating that
 * tracking ref at the local tip when absent (so a not-yet-pushed branch can be tracked). A ref
 * created here is removed again if setting the upstream fails (e.g. unknown remote).
 */
async function setUpstream(cwd, localBranch, remote, remoteBranch) {
  checkRemoteName(remote);
  const tracking = `refs/remotes/${remote}/${remoteBranch}`;
  let created = null;
  if (!(await verify(cwd, tracking))) {
    const sha = (await out(cwd, ['rev-parse', '--verify', fullBranch(localBranch)])).trim();
    // Empty old-value = create only if still absent.
    await run(cwd, ['update-ref', tracking, sha, '']);
    created = sha;
  }
  try {
    // Full ref name: `origin/x` would be ambiguous with a local branch called 'origin/x'.
    await run(cwd, ['branch', '-q', `--set-upstream-to=${tracking}`, localBranch]);
  } catch (err) {
    // Delete only if it still points where we put it.
    if (created) {
      await run(cwd, ['update-ref', '-d', tracking, created])
        .catch((e) => logger.child('git').warn('could not remove tracking ref', { ref: tracking, err: e }));
    }
    // No fetch refspec of the remote maps a branch to refs/remotes/<remote>/ (`git clone --bare`
    // sets none), so git can't tell which remote branch that ref tracks.
    throw gitErrors.classify(err, ['noTrackingRefspec'], {
      message: `Remote '${remote}' has no fetch refspec for refs/remotes/${remote}/ (a bare clone sets none), so no upstream can be tracked there. `
        + `Add one with: git config remote.${remote}.fetch '+refs/heads/*:refs/remotes/${remote}/*'`,
    });
  }
}

module.exports = { REMOTE_TIMEOUT_MS, checkRemoteName, writesBranches, mirrorRemotes, fetch, push, setUpstream };
