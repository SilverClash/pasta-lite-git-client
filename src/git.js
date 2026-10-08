'use strict';
// High-level git operations, and the facade of the git layer: reads (refs, history, diffs),
// the index and worktree (stage, discard, commit), branches (checkout, create, delete), linked
// worktrees (list, remove, prune, lock / unlock, the batched dirty check, the unreachable
// count), plus re-exports of the modules below it (status, pull, remote, hooks, git-reads,
// stash, repo-risk), so main.js and ops use one module. Every function takes a path inside the repo as `cwd` first and shells
// out through exec.run/out, which always run at the worktree root: paths passed in and returned
// are root-relative. No parsing or behaviour depends on user config.
const fs = require('node:fs');
const path = require('node:path');
const {
  GitError, kindError, tagError, run, out, tryOut, nulList, argvChunks, LITERAL_ENV, forgetRoot,
} = require('./exec');
const { resolveRoot, bareGitDir, isBare, headState, repoDirs } = require('./repo-dirs');
const { gitAt } = require('./git-process');
const { realPathOf } = require('./fs-paths');
const {
  OID, PREFIX, after, branchOf, shortName, fullBranch, parseTrack, REFSPEC_SAFE,
} = require('./gitref');
const {
  splitN, parseNulRecords, trimTrailingNewlines, parseWorktrees, parseNameStatus,
} = require('./porcelain');
const gitErrors = require('./git-errors');
const reads = require('./git-reads');
const { workdirDiff, commitDiff } = require('./diff-args');
const { messageProblem } = require('./message-rule');
const hooks = require('./hooks');
const remote = require('./remote');
const { status } = require('./status');
const { PULL_MODES, pull } = require('./pull');
const stash = require('./stash');
const risk = require('./repo-risk');

const { baseOf, verify, refExists, resolveCommit, remotes, upstreamOf, refFields, isCurrentBranch } = reads;
const { hookRefused, hookOutput, COMMIT_HOOKS } = hooks;
const { withAutostash } = stash;
const { RISKY_CONFIG, RISKY_VALUES, riskyLocalConfig, riskyHooks } = risk;

const LITERAL = { env: LITERAL_ENV };

// ---------------------------------------------------------------- read ops

/** Worktree root containing `dir`. Throws (GitError) when `dir` is not inside a worktree. */
async function root(dir) {
  return (await out(dir, ['rev-parse', '--show-toplevel'])).replace(/\n$/, '');
}

/**
 * The repository's worktrees (`git worktree list --porcelain -z`), main one first:
 * [{path, head, branch, bare, detached, locked, lockReason, prunable, prunableReason, main,
 * current, missing}]. `path` absolute as git prints it; `head` the checked-out commit (null for
 * the bare entry or an unborn branch); `branch` the short name (null when detached or bare);
 * locked / prunable: booleans, with git's reasons (null when none). `main`: the first entry (the
 * main worktree, or a bare repo's own entry). `current`: the worktree `cwd` is in (its root; for a
 * bare repo, cwd is its git dir, the bare entry's path), so the renderer never compares paths.
 * `missing`: the entry's folder doesn't exist (never for the bare entry). git marks a missing
 * folder prunable, but not a locked one, so a locked worktree whose folder is gone is only
 * `missing`. Paths are compared through fs-paths.realPathOf, all at once and each bounded by its
 * timeout: an entry on a hung mount never blocks the main process (it counts as there, and as not
 * current unless git printed the root's own spelling). Works in a bare repo (its own entry is the
 * one with bare: true) and in any worktree.
 */
async function worktrees(cwd) {
  return (await worktreeList(cwd)).entries.map((w) => {
    const entry = { ...w };
    delete entry.real;
    return entry;
  });
}

/**
 * worktrees() plus the real paths it compared, for the checks in main (ops.js) that compare
 * folders again: {here, entries}, `here` the real path of the worktree root containing `cwd`,
 * each entry with `real` (realPathOf: its spelling as git printed it when that is unknown).
 */
async function worktreeList(cwd) {
  const [raw, root] = await Promise.all([
    out(cwd, ['worktree', 'list', '--porcelain', '-z']),
    resolveRoot(cwd),
  ]);
  const list = parseWorktrees(raw);
  const [here, ...seen] = await Promise.all([realPathOf(root), ...list.map((w) => realPathOf(w.path))]);
  const entries = list.map((w, i) => ({
    ...w,
    main: i === 0,
    current: w.path === root || seen[i].real === here.real,
    missing: !w.bare && seen[i].missing,
    real: seen[i].real,
  }));
  return { here: here.real, entries };
}

/**
 * The admin folder git keeps for listed linked worktree `w` (an entry of worktreeList) in the
 * common git dir of `cwd`: the `worktrees/<id>` whose `gitdir` file points at `w`'s `.git`. It is
 * that worktree's own git dir (its HEAD, index, a stopped rebase or merge), the one `git worktree
 * remove` deletes. Found from the file system of the common dir only: nothing runs or is read in
 * `w`'s folder, which may sit on a hung mount or have a `.git` file pointing elsewhere. null when
 * none matches (the main worktree, a bare entry).
 */
async function worktreeAdminDir(cwd, w) {
  const { commonDir } = await repoDirs(cwd);
  const base = path.join(commonDir, 'worktrees');
  let ids;
  try {
    ids = fs.readdirSync(base);
  } catch {
    return null;
  }
  const pointsAt = ids.map((id) => {
    try {
      // An absolute path, or (worktree.useRelativePaths) one relative to the admin folder.
      const gitFile = fs.readFileSync(path.join(base, id, 'gitdir'), 'utf8').replace(/\r?\n$/, '');
      return { dir: path.join(base, id), folder: path.dirname(path.resolve(base, id, gitFile)) };
    } catch {
      return null;
    }
  }).filter(Boolean);
  const exact = pointsAt.find((a) => a.folder === w.path);
  if (exact) return exact.dir;
  // Another spelling of the same folder (a symlinked parent): compare real paths.
  const reals = await Promise.all(pointsAt.map((a) => realPathOf(a.folder)));
  const same = pointsAt.find((a, i) => reals[i].real === w.real);
  return same ? same.dir : null;
}

/**
 * `git worktree remove [--force] -- <wtPath>`: deletes the linked worktree's folder and git's
 * record of it. Never `-f -f`: a locked worktree is refused even with force (the user unlocks
 * it first). Kinds: 'worktree-dirty' (modified or untracked files; `submodules: true` when it
 * has submodules, which git only removes with force), 'worktree-locked', 'main-worktree',
 * 'not-found' (not a worktree). Resolves {path}. Without force git first runs `status` in that
 * worktree, with the config git reads there (its config.worktree, includeIf sections that hold
 * only there): the trust check read it when the repository was opened (repo-risk riskyNested).
 */
async function removeWorktree(cwd, wtPath, { force = false } = {}) {
  try {
    await run(cwd, ['worktree', 'remove', ...(force ? ['--force'] : []), '--', wtPath]);
  } catch (err) {
    const extra = /submodules/.test(String(err.stderr || '')) ? { submodules: true } : {};
    throw gitErrors.classify(err, ['worktreeDirty', 'worktreeLocked', 'mainWorktree', 'notAWorktree'], extra);
  }
  forgetRoot(wtPath); // its folder is gone: a later command there must not reuse the cached root
  return { path: wtPath };
}

const PRUNED = /^Removing (worktrees\/[^:]+): (.*)$/;

/**
 * `git worktree prune -v` (dryRun: `-n`, nothing is removed): forgets the worktrees whose folder
 * is gone; git keeps locked ones. Resolves {entries: [{id, reason}]}: `id` the admin folder
 * ('worktrees/<name>'), `reason` git's (e.g. "gitdir file points to non-existent location").
 * git 2.51 prints these lines on stderr; both streams are read.
 */
async function pruneWorktrees(cwd, { dryRun = false } = {}) {
  const { stdout, stderr } = await run(cwd, ['worktree', 'prune', ...(dryRun ? ['-n'] : []), '-v']);
  const entries = [];
  for (const line of `${stderr}\n${stdout}`.split('\n')) {
    const m = PRUNED.exec(line);
    if (m) entries.push({ id: m[1], reason: m[2] });
  }
  return { entries };
}

/** `git worktree lock [--reason=<reason>] -- <wtPath>`. Kind 'main-worktree'. Resolves {path}. */
async function lockWorktree(cwd, wtPath, { reason } = {}) {
  try {
    await run(cwd, ['worktree', 'lock', ...(reason ? [`--reason=${reason}`] : []), '--', wtPath]);
  } catch (err) {
    throw gitErrors.classify(err, ['mainWorktree']);
  }
  return { path: wtPath };
}

/** `git worktree unlock -- <wtPath>`. Kind 'main-worktree'. Resolves {path}. */
async function unlockWorktree(cwd, wtPath) {
  try {
    await run(cwd, ['worktree', 'unlock', '--', wtPath]);
  } catch (err) {
    throw gitErrors.classify(err, ['mainWorktree']);
  }
  return { path: wtPath };
}

// Config keys that can make `status` (or anything else) run a command: riskyLocalConfig's, by
// name only (whatever the value), for the dirty check's trust gate (worktreeTrusted).
const RISKY_NAME = new RegExp(`${RISKY_CONFIG}|${RISKY_VALUES.map(([key]) => key).join('|')}`);

/** The risky key names (RISKY_NAME) of the repo config (local and worktree scopes) git reads in `dir`, from `config -z --list`. */
function riskyNames(raw) {
  const f = raw.split('\0');
  const keys = new Set();
  for (let i = 0; i + 1 < f.length; i += 2) {
    const [scope, key] = [f[i], f[i + 1]];
    if ((scope === 'local' || scope === 'worktree') && RISKY_NAME.test(key)) keys.add(key);
  }
  return keys;
}

const CONFIG_NAMES = ['config', '--includes', '--show-scope', '-z', '--name-only', '--list'];

/**
 * The dirty check's trust gate. main asked the user about the tab's own repo config before
 * opening it (repo-trust.js), but `status` in another worktree reads config that check never saw:
 * that worktree's `config.worktree` (extensions.worktreeConfig), includeIf sections that apply
 * only there, and the whole config of whatever repo its `.git` file points at. A downloaded repo
 * could set `filter.x.clean` there and have it run on the first dirty check, with no prompt. So
 * status only runs in a worktree when (1) git there finds the same common git dir as the tab
 * (it is this repository's) and (2) every risky key (riskyLocalConfig's, by name, value or not)
 * git reads there was also set for the tab's own folder, which the user opened (and trusted for
 * those keys when there were any). Both are asked of git in that folder, so they see exactly
 * the config its `status` would; neither runs a configured program. `ours`: {commonDir (real
 * path), risky (riskyNames of its config)} of the tab.
 */
async function worktreeTrusted(dir, ours, timeout) {
  const [common, conf] = await Promise.all([
    gitAt(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { timeout }),
    gitAt(dir, CONFIG_NAMES, { timeout, okCodes: [0, 1] }),
  ]);
  if ((await realPathOf(common.stdout.replace(/\n$/, ''))).real !== ours.commonDir) return false;
  return [...riskyNames(conf.stdout)].every((k) => ours.risky.has(k));
}

/**
 * Whether each linked worktree has local changes, in one call: [{path, dirty}] for every entry of
 * a fresh list that is not bare, prunable, missing or the current one (the caller has its own
 * status). `dirty`: `status --porcelain=v1 -z --untracked-files=normal --ignore-submodules=dirty`
 * printed anything (untracked files count; a submodule counts when its checked-out commit
 * differs, not for changes inside it: those need a status run in the submodule, with its own
 * config no trust check saw, and `git worktree remove` refuses any worktree with submodules
 * without force anyway); null when it failed, ran past `timeout` ms, the entry is beyond the first
 * `max`, or the trust gate (worktreeTrusted) declined it. status runs in the entry's folder as git
 * listed it (no root lookup, which has no timeout): a folder whose `.git` file is gone is
 * prunable, so it is never asked. At most `concurrency` entries are checked at once. Never
 * rejects (a failed list gives []).
 */
async function worktreesDirty(cwd, { concurrency = 4, timeout = 8000, max = 50 } = {}) {
  let list;
  let ours;
  try {
    const [{ entries }, dirs, conf] = await Promise.all([
      worktreeList(cwd),
      repoDirs(cwd),
      run(cwd, CONFIG_NAMES, { timeout, okCodes: [0, 1] }),
    ]);
    list = entries;
    ours = { commonDir: (await realPathOf(dirs.commonDir)).real, risky: riskyNames(conf.stdout) };
  } catch {
    return [];
  }
  const todo = list.filter((w) => !w.bare && !w.prunable && !w.missing && !w.current);
  const res = todo.map((w) => ({ path: w.path, dirty: null }));
  const checked = Math.min(todo.length, max);
  const check = async (w) => {
    if (!(await worktreeTrusted(w.path, ours, timeout))) return null;
    const args = ['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignore-submodules=dirty'];
    return (await gitAt(w.path, args, { timeout })).stdout !== '';
  };
  let next = 0;
  const worker = async () => {
    while (next < checked) {
      const i = next++;
      res[i].dirty = await check(todo[i]).catch(() => null);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, checked) }, worker));
  return res;
}

/**
 * How many commits `sha` (a detached worktree's HEAD, as git listed it) reaches that no branch,
 * tag or remote-tracking ref does: what deleting that worktree would leave unreachable. Refs are
 * shared by every worktree, so it runs in `cwd`, never in the worktree's folder (which may be gone).
 */
async function unreachableCount(cwd, sha) {
  if (!OID.test(sha)) throw kindError('invalid-args', `Not a commit id: '${sha}'`);
  const n = await out(cwd, ['rev-list', '--count', sha, '--not', '--branches', '--tags', '--remotes']);
  return Number(n.trim());
}

/** Split 'origin/feature/x' into remote + branch, preferring the longest known remote name. */
function splitRemoteRef(short, remoteNames) {
  const match = remoteNames
    .filter((r) => short.startsWith(r + '/'))
    .sort((a, b) => b.length - a.length)[0];
  if (match) return { remote: match, branch: short.slice(match.length + 1) };
  const i = short.indexOf('/');
  return { remote: short.slice(0, i), branch: short.slice(i + 1) };
}

async function refs(cwd) {
  const fmt = ['%(refname)', '%(objectname)', '%(*objectname)', '%(upstream)', '%(upstream:track,nobracket)', '%(HEAD)', '%(symref)'].join('%00');
  const [raw, remoteNames, head] = await Promise.all([
    out(cwd, ['for-each-ref', `--format=${fmt}`, 'refs/heads', 'refs/remotes', 'refs/tags']),
    remotes(cwd),
    headState(cwd),
  ]);
  const { branch, sha: oid } = head;
  const res = { head: { branch, oid, detached: branch === null && oid !== null }, local: [], remote: [], tags: [] };
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const [ref, obj, peeled, upstream, track, isHead, symref] = line.split('\0');
    const name = branchOf(ref);
    if (name !== null) {
      res.local.push({
        name,
        oid: obj,
        upstream: upstream ? shortName(upstream) : null,
        ...parseTrack(track),
        current: isHead === '*',
      });
    } else if (ref.startsWith(PREFIX.REMOTES)) {
      if (symref || ref.endsWith('/HEAD')) continue;
      const short = after(ref, PREFIX.REMOTES);
      res.remote.push({ name: short, ...splitRemoteRef(short, remoteNames), oid: obj });
    } else {
      res.tags.push({ name: after(ref, PREFIX.TAGS) ?? ref, oid: peeled || obj });
    }
  }
  return res;
}

const LOG_FIELDS = ['%H', '%P', '%an', '%ae', '%at', '%cn', '%ct', '%s', '%b'];

/** Sorted, de-duplicated commit-ish ids of every branch, remote branch, tag and HEAD. */
async function currentTips(cwd) {
  const [raw, head] = await Promise.all([
    out(cwd, ['for-each-ref', '--format=%(objectname) %(objecttype) %(*objecttype)', 'refs/heads', 'refs/remotes', 'refs/tags']),
    headState(cwd),
  ]);
  const tips = new Set(head.sha ? [head.sha] : []);
  for (const line of raw.split('\n')) {
    const [oid, type, peeledType] = line.split(' ');
    if (oid && (type === 'commit' || (type === 'tag' && peeledType === 'commit'))) tips.add(oid);
  }
  return [...tips].sort(); // NOSONAR(S2871): hex object ids; code-unit order is the intended order
}

/**
 * Commit history across every ref tip, newest first (--date-order).
 *
 * Paging contract: the first call (no `tips`) snapshots the current ref tips and returns them
 * as `tips`, plus `next` = { tips, skip } when `hasMore`. Pass `next` back
 * (`log(cwd, { limit, ...res.next })`) for the following page: the walk starts from the very
 * same tips, so it is identical and pages neither overlap nor miss commits even if refs moved
 * in between (commits reachable only from new ref positions appear after a fresh first call).
 * Commits within a page are unique by hash.
 * @returns {Promise<{commits: object[], hasMore: boolean, tips: string[], next: {tips: string[], skip: number}|null}>}
 */
async function log(cwd, { limit = 2000, skip = 0, tips } = {}) {
  if (tips && !tips.every((t) => OID.test(t))) throw kindError('invalid-args', 'log: tips must be full object ids');
  const walk = tips ? [...tips] : await currentTips(cwd);
  if (!walk.length) return { commits: [], hasMore: false, tips: [], next: null };
  const raw = await out(cwd, [
    'rev-list', '--date-order', '--ignore-missing', `--max-count=${limit + 1}`, `--skip=${skip}`,
    '--no-commit-header', `--format=${LOG_FIELDS.join('%x00')}%x00`, '--stdin',
  ], { input: walk.join('\n') + '\n' });
  // rev-list prints each commit once, so no de-duplication is needed.
  const commits = parseNulRecords(raw, LOG_FIELDS.length)
    .filter(([hash]) => hash)
    .map(([hash, parents, author, email, date, committer, committerDate, subject, body]) => ({
      hash,
      parents: parents ? parents.split(' ') : [],
      author,
      email,
      date: Number(date),
      committer,
      committerDate: Number(committerDate),
      subject,
      body: trimTrailingNewlines(body),
    }));
  const hasMore = commits.length > limit;
  if (hasMore) commits.length = limit;
  return { commits, hasMore, tips: walk, next: hasMore ? { tips: walk, skip: skip + limit } : null };
}

async function commitFiles(cwd, sha) {
  const base = await baseOf(cwd, sha);
  return parseNameStatus(await out(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--name-status', '-z', '-M', base, sha, '--'], { diff: true }));
}

/**
 * Patch of `file` in commit `sha` vs its first parent (renames detected with -M).
 * Latin-1 encoded (one char per byte): decode for display with hunks.decodeForDisplay.
 */
async function diffCommitFile(cwd, sha, file, orig) {
  const base = await baseOf(cwd, sha);
  const { args, opts } = commitDiff(base, sha, orig && orig !== file ? [orig, file] : [file]);
  return out(cwd, args, opts);
}

/**
 * Patch for one file: index→workdir, HEAD→index (`staged`) or /dev/null→file (`untracked`),
 * with exactly the argument lists hunks.js indexes. Latin-1 encoded (one char per byte) so
 * hunks' byte fingerprints match: decode for display with hunks.decodeForDisplay.
 *
 * `orig` (a rename's source path, from status): diff both paths with rename detection (-M), so
 * a rename shows as one "rename from/to" section instead of a whole new file. Not what hunks.js
 * indexes (it works on `file` alone), so such a patch must never be used for line staging.
 * Refused for untracked files. Without `orig` (or orig === file) the argument lists are the
 * ones above, unchanged.
 */
async function diffWorkdir(cwd, file, { staged = false, untracked = false, orig } = {}) {
  const rename = typeof orig === 'string' && orig !== '' && orig !== file;
  if (untracked && rename) throw kindError('invalid-args', 'An untracked file has no rename source');
  // `diff --no-index` follows symlinked parent folders (lnk -> /elsewhere, g -> .git), so only
  // diff paths git itself lists as untracked (it never lists paths beyond a symlink).
  if (untracked && !(await isUntracked(cwd, file))) {
    throw kindError('invalid-args', `Not an untracked file in the worktree: '${file}'`);
  }
  const { args, opts } = workdirDiff(file, { staged, untracked, orig: rename ? orig : undefined });
  return out(cwd, args, opts);
}

/** True when `file` is exactly a path `git ls-files --others --exclude-standard` lists. */
async function isUntracked(cwd, file) {
  if (typeof file !== 'string' || !file) return false;
  const raw = await out(cwd, ['ls-files', '-z', '--others', '--exclude-standard', '--', file], LITERAL);
  return raw.split('\0').includes(file);
}

/** {sha, message, summary} of commit `sha` (message as stored minus trailing newlines; summary = subject). */
async function commitInfo(cwd, sha) {
  const raw = await out(cwd, ['log', '-1', '--no-walk', '--format=%s%x00%B', sha, '--']);
  const [summary, body = ''] = splitN(raw, '\0', 2);
  return { sha, message: trimTrailingNewlines(body), summary };
}

/** {sha, message, summary} of HEAD, or null in an unborn repo (for the Amend checkbox). */
async function lastCommit(cwd) {
  const { sha } = await headState(cwd);
  return sha ? commitInfo(cwd, sha) : null;
}

// ---------------------------------------------------------------- index / worktree

async function stage(cwd, paths) {
  if (!paths.length) return;
  await run(cwd, ['add', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: nulList(paths), ...LITERAL });
}

async function stageAll(cwd) {
  await run(cwd, ['add', '-A']);
}

async function unstage(cwd, paths) {
  if (!paths.length) return;
  const args = (await headState(cwd)).sha
    ? ['restore', '--staged', '--pathspec-from-file=-', '--pathspec-file-nul']
    : ['rm', '--cached', '-r', '-q', '--ignore-unmatch', '--pathspec-from-file=-', '--pathspec-file-nul'];
  await run(cwd, args, { input: nulList(paths), ...LITERAL });
}

async function unstageAll(cwd) {
  if ((await headState(cwd)).sha) await run(cwd, ['reset', '-q']);
  else await run(cwd, ['rm', '--cached', '-r', '-q', '--ignore-unmatch', '--', '.']);
}

/** The subset of `paths` that `git ls-files --others --exclude-standard` lists exactly (files only). */
async function untrackedFiles(cwd, paths) {
  const listed = new Set();
  for (const chunk of argvChunks(paths)) {
    const raw = await out(cwd, ['ls-files', '-z', '--others', '--exclude-standard', '--', ...chunk], LITERAL);
    for (const p of raw.split('\0')) if (p) listed.add(p);
  }
  // 'sub/' = a nested repository: never handed to clean (it is not a file).
  return paths.filter((p) => listed.has(p) && !p.endsWith('/'));
}

/**
 * Throw away working-tree changes of `files` ([{path, status}], status '?' = untracked). Callers
 * must snapshot for undo first. The '?' status is not trusted: only paths git itself lists as
 * untracked files are deleted (never a folder, so a tracked folder's untracked files survive).
 * A '?' path that exists but isn't an untracked file (tracked, ignored, a folder) throws kind
 * 'stale' before anything changes; one that is already gone is skipped.
 */
async function discard(cwd, files) {
  const asked = [...new Set(files.filter((f) => f.status === '?').map((f) => f.path))];
  const tracked = files.filter((f) => f.status !== '?').map((f) => f.path);
  const untracked = asked.length ? await untrackedFiles(cwd, asked) : [];
  if (untracked.length !== asked.length) {
    const ok = new Set(untracked);
    const root = await resolveRoot(cwd);
    const stale = asked.filter((p) => !ok.has(p) && fs.lstatSync(path.join(root, p), { throwIfNoEntry: false }));
    if (stale.length) {
      throw kindError('stale', `Not an untracked file any more: '${stale[0]}'. Refresh and try again.`, { paths: stale });
    }
  }
  if (tracked.length) {
    await run(cwd, ['restore', '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: nulList(tracked), ...LITERAL });
  }
  for (const chunk of argvChunks(untracked)) await run(cwd, ['clean', '-f', '-q', '--', ...chunk], LITERAL);
}

/**
 * Commit the index. The message is stored as typed minus leading/trailing blank lines and
 * trailing whitespace (`--cleanup=whitespace`: '#' lines are kept, since what the user typed is the
 * message, e.g. a '#123' issue number at line start), whatever commit.cleanup / commit.verbose say. Returns the new HEAD sha.
 * Errors (err.kind): 'empty-message' (blank message; git never runs), 'nothing-to-commit'
 * (nothing staged and not amending), 'hook-failed' (pre-commit / prepare-commit-msg /
 * commit-msg exited non-zero; message = the hook's output, at most ~4k chars), 'conflicts'
 * (unmerged paths, like pull / stash), 'aborted' / 'timeout'; anything else is git's GitError as is.
 */
async function commit(cwd, message, { amend = false, only = false } = {}) {
  // messageRule's type and blank checks (a NUL byte is left to git, which refuses it).
  if (['type', 'blank'].includes(messageProblem(message, { max: Infinity }))) throw kindError('empty-message', 'Commit message cannot be empty');
  const args = ['commit', '--file=-', '--quiet', '--cleanup=whitespace', '--no-verbose'];
  if (amend) args.push('--amend');
  if (only) args.push('--only');
  try {
    await run(cwd, args, { input: message });
  } catch (err) {
    throw await commitError(cwd, err);
  }
  return (await headState(cwd)).sha;
}

/** A failed `git commit`'s error, classified: nothing-to-commit | conflicts | hook-failed (or as is). */
async function commitError(cwd, err) {
  if (!gitErrors.unclassified(err)) return err;
  if (gitErrors.matches(err, 'nothingToCommit')) {
    return tagError(err, 'nothing-to-commit', { message: 'Nothing to commit: no changes are staged' });
  }
  if (gitErrors.matches(err, 'unmerged')) return tagError(err, 'conflicts');
  if (err.exitCode === 1 && (await hookRefused(cwd, err, COMMIT_HOOKS))) {
    return tagError(err, 'hook-failed', { message: hookOutput(err.stderr || err.stdout) });
  }
  return err;
}

// ---------------------------------------------------------------- branches

/** Local changes block the switch (they are then autostashed): git.errors' 'overwritten' rule. */
const blockedByChanges = (err) => err instanceof GitError && gitErrors.matches(err, 'overwritten');

async function checkoutArgs(cwd, ref, kind) {
  if (kind === 'commit') return ['checkout', '-q', '--detach', ref];
  if (kind === 'remote') {
    const { branch } = splitRemoteRef(ref, await remotes(cwd));
    await validateBranchName(cwd, branch, 'local branch name');
    if (!(await refExists(cwd, fullBranch(branch)))) {
      return ['checkout', '-q', '-b', branch, '--track', `refs/remotes/${ref}`];
    }
    // Reuse the local branch only when it already tracks this remote branch.
    const up = await upstreamOf(cwd, branch);
    if (!up || up.ref !== `refs/remotes/${ref}`) {
      throw kindError('local-exists', `A local branch '${branch}' already exists and does not track '${ref}'`, { branch });
    }
    return ['checkout', '-q', '--no-guess', branch, '--'];
  }
  // --no-guess: a name with no local branch must fail, not DWIM-create a tracking branch.
  return ['checkout', '-q', '--no-guess', ref, '--'];
}

/** A branch checked out in another worktree can't be checked out here (kind 'checked-out-elsewhere'). */
const elsewhere = (err) => gitErrors.classify(err, ['checkedOutElsewhere']);

async function checkout(cwd, ref, { kind = 'local' } = {}) {
  const args = await checkoutArgs(cwd, ref, kind);
  try {
    await run(cwd, args);
  } catch (err) {
    if (!blockedByChanges(err)) throw elsewhere(err);
    await withAutostash(cwd, () => run(cwd, args).catch((e) => { throw elsewhere(e); }));
  }
  const { branch, sha } = await headState(cwd);
  return { branch, oid: sha };
}

/** A non-empty string that can't be read as an option or split a line (checked before asking git). */
const isPlainName = (name) => typeof name === 'string' && name !== '' && !name.startsWith('-') && !/[\0\n]/.test(name);

/**
 * Throw kind 'invalid-args' unless `name` is a valid branch name by git's own rules
 * (`check-ref-format --branch`, which also rejects `* : ^ ~ ? [ \`, spaces, '..', '@{', 'HEAD';
 * the output must equal the input, so '@{-1}'-style shorthands never expand) and doesn't start
 * with '-'.
 */
async function validateBranchName(cwd, name, what = 'branch name') {
  const bad = () => kindError('invalid-args', `Invalid ${what}: '${name}'`);
  if (!isPlainName(name)) throw bad();
  const norm = await tryOut(cwd, ['check-ref-format', '--branch', name]);
  if (norm === null || norm.replace(/\n$/, '') !== name) throw bad();
  return name;
}

/**
 * Create branch `name` at `start`; with checkout, switch to it. Local changes that block the
 * switch are auto-stashed and re-applied as for checkout (withAutostash: kind 'stash-conflict'
 * or err.stashKept; git creates the branch only once the switch succeeds).
 */
async function createBranch(cwd, name, { start = 'HEAD', checkout: doCheckout = false } = {}) {
  await validateBranchName(cwd, name);
  if (doCheckout) {
    const args = ['switch', '-q', '--no-track', '-c', name, start];
    try {
      await run(cwd, args);
    } catch (err) {
      if (!blockedByChanges(err)) throw err;
      await withAutostash(cwd, () => run(cwd, args));
    }
  } else {
    await run(cwd, ['branch', '--no-track', name, start]);
  }
  return { name, sha: (await out(cwd, ['rev-parse', '--verify', fullBranch(name)])).trim() };
}

/** Delete a local branch; returns what was deleted so undo can recreate it. */
async function deleteBranch(cwd, name, { force = false } = {}) {
  if (await isCurrentBranch(cwd, name)) throw kindError('current-branch', `Cannot delete the current branch '${name}'`);
  const row = await refFields(cwd, fullBranch(name), ['%(objectname)', '%(upstream:short)']);
  if (!row) throw kindError('not-found', `Branch '${name}' not found`);
  const [sha, upstream] = row;
  return removeBranch(cwd, { name, sha, upstream: upstream || null }, { force });
}

/**
 * Every local branch in one for-each-ref: Map name -> {sha, upstream (short name) | null}. What
 * several deletes check their names against (instead of a lookup per branch).
 */
async function branchTips(cwd) {
  const raw = await out(cwd, ['for-each-ref', `--format=${['%(refname)', '%(objectname)', '%(upstream:short)'].join('%00')}`, 'refs/heads']);
  const tips = new Map();
  for (const line of raw.split('\n')) {
    const [ref, sha, upstream] = line.split('\0');
    const name = ref ? branchOf(ref) : null;
    if (name !== null) tips.set(name, { sha, upstream: upstream || null });
  }
  return tips;
}

/**
 * `git branch -d` (force: -D) of local branch {name, sha, upstream} the caller already looked up
 * (deleteBranch, or branchTips with HEAD checked); resolves to it. Kinds: 'not-merged',
 * 'checked-out-elsewhere'.
 */
async function removeBranch(cwd, { name, sha, upstream }, { force = false } = {}) {
  try {
    await run(cwd, ['branch', force ? '-D' : '-d', name]);
  } catch (err) {
    // Not fully merged (force deletes it), or "cannot delete branch 'x' used by worktree at
    // '<path>'" (or "checked out at"): a linked worktree has it checked out (from a bare repo or
    // from another worktree); git's message kept.
    throw gitErrors.classify(err, ['notFullyMerged', 'checkedOutElsewhere']);
  }
  return { name, sha, upstream: upstream || null };
}

module.exports = {
  OID, REFSPEC_SAFE, splitN, trimTrailingNewlines,
  validateBranchName, isUntracked,
  root, bareGitDir, isBare, riskyLocalConfig, riskyHooks, riskyNested: risk.riskyNested, refs, log,
  worktrees, worktreeList, worktreeAdminDir, removeWorktree, pruneWorktrees, lockWorktree, unlockWorktree, worktreesDirty, unreachableCount,
  commitFiles, diffCommitFile, diffWorkdir,
  stage, stageAll, unstage, unstageAll, discard, argvChunks,
  commit, lastCommit, commitInfo, commitError,
  checkout, createBranch, deleteBranch, branchTips, removeBranch, isPlainName,
  // The modules git.js builds on, re-exported: this is the facade main.js, ops and tests use.
  status, PULL_MODES, pull,
  REMOTE_TIMEOUT_MS: remote.REMOTE_TIMEOUT_MS, mirrorRemotes: remote.mirrorRemotes, writesBranches: remote.writesBranches,
  fetch: remote.fetch, push: remote.push, setUpstream: remote.setUpstream,
  verify, refExists, resolveCommit, remotes, upstreamOf, isCurrentBranch,
  commitPaths: reads.commitPaths,
  hasHook: hooks.hasHook, hasCommitHook: hooks.hasCommitHook, hookOutput, HOOK_OUTPUT_MAX: hooks.HOOK_OUTPUT_MAX,
  stashes: stash.stashes, stashIndexOf: stash.stashIndexOf, stashPush: stash.stashPush, stashApply: stash.stashApply,
  stashDrop: stash.stashDrop, stashPop: stash.stashPop, trackedChanges: stash.trackedChanges,
  reapplyStash: stash.reapplyStash, withAutostash,
};
