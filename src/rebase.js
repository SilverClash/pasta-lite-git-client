'use strict';
// Rebases (docs/plans/rebase.md §3–4): starting one (plain, interactive, Pull's), Continue / Skip /
// Abort of a stopped one (ours or one a terminal started). Our persistent autostash, shared with
// merges (src/merge.js), is src/autostash.js; the state readers live in src/rebase-state.js.
//
// The state folder <git-dir>/pasta-lite/rebase/ (per worktree; autostash.js keeps its intent
// file one level up):
//   meta.json         {version, id, startedAt, op, origHead, onto, ontoName, branch, ...what the
//                     result needs at the finish}, written before a rebase we start; the rebase
//                     is "ours" while its origHead is rebase-merge/orig-head and its id is in
//                     rebase-merge/pasta-lite-id, written once git's start command has exited
//                     (never while git may be removing the folder). Until then meta.starting is
//                     set, and a rebase with that origHead and no marker is ours: a long start, or
//                     one the app died during, still reads as ours.
//   stop.json         {origHead, head, kind: 'hook'|'signing', output}: why our last continue/skip
//                     stopped without conflicts (valid while HEAD and orig-head are unchanged)
//   todo              the todo the editor helper copies (R3)
//   msgs/<sha>        a message the helper gives git for commit <sha> (reword, squash, conflict stop)
// Every file there is created exclusively (0600) and a symlink anywhere on the way is refused.
// Messages only ever go into msgs/ files: never into argv, env, meta.json or the logs.
const path = require('node:path');
const exec = require('./exec');
const { headState, gitDir, repoState } = require('./repo-dirs');
const rs = require('./rebase-state');
const { status } = require('./status');
const { hookRefused, hookOutput, COMMIT_HOOKS } = require('./hooks');
const { readSmall, isRealDir, exists } = require('./gitfiles');
const { OID, PREFIX, after, branchOf } = require('./gitref');
const { parseNulRecords, trimTrailingNewlines } = require('./porcelain');
const { isAncestor, upstreamOf } = require('./git-reads');
const gitErrors = require('./git-errors');
const { logKind } = require('./ipc-errors');
const { messageProblem } = require('./message-rule');
const { logger } = require('./log');

const { run, out, tryOut, kindError, tagError, GitError, withSignal } = exec;
const { oid, stateDirOf, writeStateFile, ensureStateDir, hasMessages, HASH_COMMENTS } = rs;
const { refusePendingAutostash, runWithAutostash, keptFields, settleAutostash, KEPT_WHY } = require('./autostash');

const log = logger.child('rebase');
const warn = (what) => (e) => log.warn(what, { kind: logKind(e) });

/**
 * Config overrides for every rebase command, so user config can't change what we parse or do
 * (§3.1). Rebases we start also get HASH_COMMENTS; a rebase a terminal started keeps the repo's
 * core.commentChar, since git wrote its "Conflicts:" notes into the stopped commit's message with
 * that character, and `commit.cleanup=strip` must remove exactly those lines ('auto' is the
 * exception: git wrote them with '#' and would pick another character when committing).
 */
const REBASE_CONFIG = Object.freeze([
  '-c', 'rebase.missingCommitsCheck=error',
  '-c', 'rebase.abbreviateCommands=false',
  '-c', 'rebase.instructionFormat=',
  '-c', 'rebase.rescheduleFailedExec=false',
  '-c', 'rebase.forkPoint=false',
  '-c', 'commit.cleanup=strip',
  '-c', 'advice.mergeConflict=false',
  '-c', 'advice.skippedCherryPicks=false',
]);

/** Flags of every rebase we start (the target, a full object id, follows them). */
const START_FLAGS = Object.freeze([
  '--merge', '--no-autostash', '--no-autosquash', '--no-rebase-merges', '--no-fork-point', '--no-update-refs', '--empty=drop',
]);

const HELPER = path.join(__dirname, 'rebase-editor.js');
/** Max commits whose shas meta.json keeps to report drops at the finish (beyond: none reported). */
const REPLAYED_MAX = 10000;

/**
 * Env for a rebase command that may open an editor: the helper (§3.3) as GIT_EDITOR, and with
 * `todo` also as GIT_SEQUENCE_EDITOR. The command strings are constants; data goes through env only.
 */
function helperEnv(gd, { todo = false } = {}) {
  return {
    PL_NODE: process.execPath,
    ELECTRON_RUN_AS_NODE: '1',
    PL_REBASE_HELPER: HELPER,
    PL_REBASE_DIR: stateDirOf(gd),
    PL_GIT_DIR: gd,
    GIT_EDITOR: '"$PL_NODE" "$PL_REBASE_HELPER" msg',
    ...(todo ? { GIT_SEQUENCE_EDITOR: '"$PL_NODE" "$PL_REBASE_HELPER" todo' } : {}),
  };
}

/** git <REBASE_CONFIG> [HASH_COMMENTS] rebase <args>. */
const runRebase = (cwd, args, { hashComments = true, ...opts } = {}) => run(cwd, [...REBASE_CONFIG, ...(hashComments ? HASH_COMMENTS : []), 'rebase', ...args], opts);

/** `rev-list --count <args>` (0 when git fails). */
const count = async (cwd, args) => Number(((await tryOut(cwd, ['rev-list', '--count', ...args])) || '0').trim()) || 0;

/** The rebase is over (finished or aborted): clear the state folder, then bring our autostash back. */
async function finish(cwd, gd) {
  rs.clearState(gd);
  return settleAutostash(cwd);
}

// ---------------------------------------------------------------- what a finished rebase did

/**
 * The commits `args` (rev-list arguments, or `input` on --stdin) keyed so their rebased copies
 * can be found again: a rebase keeps each commit's author (name, email, date) and subject.
 */
async function replayKeys(cwd, args, input) {
  const raw = await out(cwd, ['rev-list', '--no-merges', '--no-commit-header', '--format=%H%x00%an%x00%ae%x00%at%x00%s%x00', ...args, ...(input ? ['--stdin'] : [])], input ? { input } : {});
  return parseNulRecords(raw, 5).filter(([sha]) => OID.test(sha)).map(([sha, ...key]) => ({ sha, key: key.join('\0') }));
}

const shaLines = (shas) => shas.map((s) => `${s}\n`).join('');

/** Of the commits `replayed` (shas), the ones with no rebased copy in onto..after. */
async function droppedCommits(cwd, replayed, onto, after) {
  const kept = new Map();
  for (const c of await replayKeys(cwd, [after, `^${onto}`])) kept.set(c.key, (kept.get(c.key) || 0) + 1);
  return (await replayKeys(cwd, ['--no-walk=unsorted'], shaLines(replayed))).filter((c) => {
    const n = kept.get(c.key) || 0;
    if (n) kept.set(c.key, n - 1);
    return !n;
  }).map((c) => c.sha);
}

/**
 * The groups a todo makes (drops left out, as git skips them between a pick and its squashes):
 * [{head, members: [sha], squash: boolean, reword: boolean}], oldest first. `squash`: the group
 * has a `squash` (so git asks for its final message, keyed by the last member).
 */
function todoGroups(todo) {
  const groups = [];
  for (const { cmd, sha } of todo) {
    if (cmd === 'drop') continue;
    if ((cmd === 'squash' || cmd === 'fixup') && groups.length) {
      const g = groups[groups.length - 1];
      g.members.push(sha);
      if (cmd === 'squash') g.squash = true;
    } else {
      groups.push({ head: sha, members: [sha], squash: false, reword: cmd === 'reword' });
    }
  }
  return groups;
}

/**
 * The groups of `todo` whose commit is missing from onto..after (`--empty=drop` dropped them), by
 * their first commit's sha. `renamed`: the shas a message was given for. Best effort: a rebased
 * commit keeps its author (name, email, date), and its subject unless the group got a new message
 * (a reword, a squash with a message, or an edit, which may have been amended).
 */
async function droppedGroups(cwd, todo, renamed, onto, after) {
  const groups = todoGroups(todo);
  if (!groups.length) return [];
  const raw = await out(cwd, ['rev-list', '--no-walk=unsorted', '--no-commit-header', '--format=%H%x00%an%x00%ae%x00%at%x00%s%x00', '--stdin'], { input: shaLines(groups.map((g) => g.head)) });
  const keyOf = new Map(parseNulRecords(raw, 5).map(([sha, an, ae, at, s]) => [sha, { author: `${an}\0${ae}\0${at}`, subject: s }]));
  const full = new Map();
  const authors = new Map();
  const bump = (m, k, d) => m.set(k, (m.get(k) || 0) + d);
  for (const c of await replayKeys(cwd, [after, `^${onto}`])) {
    bump(full, c.key, 1);
    bump(authors, c.key.split('\0').slice(0, 3).join('\0'), 1);
  }
  // An `edit` stop may have amended the message too.
  const edits = new Set(todo.filter((l) => l.cmd === 'edit').map((l) => l.sha));
  const isRenamed = (g) => g.reword || edits.has(g.head) || (g.squash && renamed.has(g.members[g.members.length - 1]));
  const dropped = new Set();
  // Groups that keep their subject match on the full key first; the renamed ones on the author.
  for (const g of groups.filter((x) => !isRenamed(x))) {
    const k = keyOf.get(g.head);
    const fk = k && `${k.author}\0${k.subject}`;
    if (k && full.get(fk)) {
      bump(full, fk, -1);
      bump(authors, k.author, -1);
    } else dropped.add(g.head);
  }
  for (const g of groups.filter(isRenamed)) {
    const k = keyOf.get(g.head);
    if (k && authors.get(k.author) > 0) bump(authors, k.author, -1);
    else dropped.add(g.head);
  }
  return groups.filter((g) => dropped.has(g.head)).map((g) => g.head);
}

const shaList = (v) => (Array.isArray(v) && v.every((s) => oid(s) === s) ? v : null);

/**
 * What a rebase we started left out, from what meta.json kept since the start (so it survives
 * stops): {dropped: [sha], skippedCherryPicks}, or null when meta has nothing to go on.
 */
async function startDrops(cwd, meta, after) {
  if (!oid(meta.onto)) return null;
  if (meta.op === 'rebase-interactive') {
    const todo = Array.isArray(meta.todo) ? meta.todo.filter((l) => l && typeof l.cmd === 'string' && oid(l.sha) === l.sha) : [];
    return { dropped: await droppedGroups(cwd, todo, new Set(shaList(meta.renamed) || []), meta.onto, after), skippedCherryPicks: 0 };
  }
  const replayed = shaList(meta.replayed);
  if (!replayed) return null;
  const dropped = replayed.length ? await droppedCommits(cwd, replayed, meta.onto, after) : [];
  return { dropped, skippedCherryPicks: Math.max(0, (Number.isInteger(meta.total) ? meta.total : 0) - replayed.length) };
}

/**
 * Commits of `origHead` (since `onto`) the rebase rewrote to a new sha or dropped (so they are
 * no longer in `after`), that some remote-tracking ref has: what a force push would replace.
 */
async function publishedCount(cwd, onto, origHead, after) {
  if (!onto || !origHead || !after) return 0;
  const gone = [origHead, `^${onto}`, `^${after}`];
  return Math.max(0, (await count(cwd, gone)) - (await count(cwd, [...gone, '--not', '--remotes'])));
}

// ---------------------------------------------------------------- continue / skip / abort

const { failureKind } = gitErrors;

/** Facts of a rebase we start, for outcome(). */
const startCtx = (gd, branch, onto, before) => ({
  gd, rebase: { ours: true }, branch, onto, origHead: before, stoppedSha: null, emptyStop: false, start: true,
});

/** Facts about the stopped rebase that outcome() needs once git has run. */
async function context(cwd) {
  const st = await status(cwd);
  const r = st.rebase;
  if (!r) throw kindError('not-rebasing', 'No rebase is in progress', { state: st.state });
  return {
    gd: await gitDir(cwd), rebase: r, branch: r.branch, onto: r.onto, origHead: r.origHead,
    stoppedSha: r.stoppedSha, emptyStop: r.stop === 'empty' && !!r.stoppedSha,
  };
}

/** A start that git refused before anything changed, classified: dirty | hook-failed (pre-rebase) | as is. */
async function classifyStartError(cwd, err) {
  if (gitErrors.kindFor(err, 'uncommittedChanges')) return gitErrors.classify(err, ['uncommittedChanges']);
  if (gitErrors.unclassified(err) && (await hookRefused(cwd, err, ['pre-rebase']))) {
    return tagError(err, 'hook-failed', { message: hookOutput(err.stderr || err.stdout) });
  }
  return err;
}

/**
 * A rebase we started that never began (state clean, HEAD where it was): a `pre-rebase` hook
 * refusal (kind 'hook-failed'), unstaged changes git refused (kind 'dirty'), a cancel, or
 * anything else git said. The autostash comes back first; if it can't, the error says so
 * (stashKept, stash).
 */
async function startFailed(cwd, ctx, err) {
  const fin = await finish(cwd, ctx.gd);
  throw Object.assign(await classifyStartError(cwd, err), keptFields(fin));
}

/** The rebase stopped (conflicts, an edit, a failing hook or signing): the 'stopped' result. */
async function stopped(cwd, ctx, st, err) {
  const dropped = ctx.emptyStop && st.rebase.stoppedSha !== ctx.stoppedSha ? [ctx.stoppedSha] : [];
  if (err && err.kind) throw Object.assign(err, { rebase: st.rebase });
  if (!err || st.conflicted.length) return { status: 'stopped', state: st.rebase, dropped };
  // git's text is classified first: with a commit hook installed (husky and the like), a file in
  // the way is still not a hook failure.
  const signing = failureKind(err) === 'signing';
  if (!signing && !(await hookRefused(cwd, err, COMMIT_HOOKS))) throw Object.assign(err, { rebase: st.rebase });
  const output = hookOutput(err.stderr || err.stdout);
  writeStateFile(ensureStateDir(ctx.gd), 'stop.json', JSON.stringify({
    origHead: st.rebase.origHead, head: st.oid, kind: signing ? 'signing' : 'hook', output,
  }));
  return { status: 'stopped', state: (await status(cwd)).rebase, dropped, ...(signing ? {} : { hookOutput: output }) };
}

/** The rebase finished: the state folder goes, the autostash comes back, the 'done' result. */
async function finished(cwd, ctx) {
  const meta = rs.readMeta(ctx.gd);
  const started = ctx.rebase.ours && meta && meta.origHead === ctx.origHead ? meta : null;
  const fin = await finish(cwd, ctx.gd);
  const { sha: after } = await headState(cwd);
  const drops = started && after ? await startDrops(cwd, started, after).catch((e) => warn('could not work out the dropped commits')(e)) : null;
  let dropped = [];
  if (drops) dropped = drops.dropped;
  else if (ctx.emptyStop) dropped = [ctx.stoppedSha];
  return {
    status: 'done',
    branch: ctx.branch,
    before: ctx.origHead,
    after,
    fastForward: !!(started && started.fastForward === true),
    dropped,
    skippedCherryPicks: drops ? drops.skippedCherryPicks : 0,
    published: await publishedCount(cwd, ctx.onto, ctx.origHead, after),
    undoRecorded: false,
    ...fin,
  };
}

/**
 * What a start / continue / skip left: {status: 'done' | 'stopped'} or a throw. `ctx` holds the
 * facts read before git ran. Runs under no signal: once git has stopped, reading the state and
 * re-applying the autostash must not be cut short. A cancelled command (kind 'aborted') that
 * left a stopped rebase rethrows with `rebase` (the RebaseState).
 */
function outcome(cwd, ctx, err) {
  return withSignal(undefined, async () => {
    if (ctx.start) {
      try {
        rs.markOurs(ctx.gd);
      } catch (e) {
        warn('could not mark the rebase as ours')(e);
      }
    }
    const st = await status(cwd);
    if (st.state === 'rebasing') return stopped(cwd, ctx, st, err);
    if (st.state !== 'clean') {
      if (err) throw err;
      throw kindError('in-progress', `The rebase ended, but the repository is now ${st.state}`, { state: st.state });
    }
    if (err && ctx.start && (await headState(cwd)).sha === ctx.origHead) return startFailed(cwd, ctx, err);
    // Finished (possibly by a cancel that came too late).
    const result = await finished(cwd, ctx);
    if (err && err.kind !== 'aborted') throw Object.assign(err, { result });
    return result;
  });
}

/**
 * True when our rebase stopped at a `reword` because its commit hook (or signing) failed and the
 * new message never got committed: git left `amend` naming HEAD (the picked commit, old message)
 * and msgs/<sha> still holds the message.
 */
async function rewordRetry(cwd, ctx) {
  const r = ctx.rebase;
  if (!r.ours || (r.stop !== 'hook' && !r.signingFailed) || !r.current || r.current.cmd !== 'reword' || !r.current.sha) return false;
  const amend = oid(readSmall(path.join(ctx.gd, 'rebase-merge', 'amend')));
  return !!amend && amend === (await headState(cwd)).sha && rs.preparedMessage(ctx.gd, r.current.sha) !== null;
}

/**
 * Kind 'rebase-exec' when the rest of the rebase's todo runs shell commands (exec lines), which
 * a Continue or Skip would make git run. We never write one (src/rebase-editor.js), so it came
 * from a terminal or with the folder: whoever started it, only Abort is offered.
 */
function refuseExec(r) {
  if (r && r.runsCommands) {
    throw kindError('rebase-exec', 'The rest of this rebase runs commands (exec lines in its todo), which Pasta Lite never runs. '
      + 'Continue it in a terminal if you trust it, or abort it', { state: 'rebasing' });
  }
}

/**
 * Run `rebase <flag>` for a stopped rebase, with the helper as GIT_EDITOR when a message waits.
 * `message`: the message for the stopped commit (msgs/<sha>, see continue_). The state folder
 * of a rebase that isn't ours is left from an earlier one (aborted or finished in a terminal):
 * it is cleared first, so none of its prepared messages reaches this rebase; the helper then
 * runs only for the message given now. Refused (refuseExec) when the todo runs commands.
 */
async function step(cwd, ctx, flag, { message } = {}) {
  refuseExec(ctx.rebase);
  const { ours } = ctx.rebase;
  if (!ours) rs.clearState(ctx.gd);
  if (message !== undefined) {
    const sha = ctx.stoppedSha || (ctx.rebase.current && ctx.rebase.current.sha);
    if (!sha) throw kindError('invalid-args', 'There is no stopped commit to give a message to');
    writeStateFile(path.join(ensureStateDir(ctx.gd), 'msgs'), sha, message);
  }
  const retry = flag === '--continue' && (await rewordRetry(cwd, ctx));
  const hashComments = ours || (await rs.commentConfig(cwd)).auto;
  const helper = message !== undefined || (ours && hasMessages(ctx.gd));
  rs.removeStateFile(ctx.gd, 'stop.json');
  try {
    // git's continue after a reword whose commit hook (or signing) failed keeps the old message
    // (verified): commit the prepared one first (the hooks run again; a new refusal is a new stop).
    if (retry) await run(cwd, ['-c', 'commit.cleanup=strip', ...HASH_COMMENTS, 'commit', '--amend', '--edit', '--quiet', '--no-verbose'], { env: helperEnv(ctx.gd) });
    await runRebase(cwd, [flag], { hashComments, ...(helper ? { env: helperEnv(ctx.gd) } : {}) });
  } catch (err) {
    return outcome(cwd, ctx, err);
  }
  return outcome(cwd, ctx, null);
}

/**
 * `rebase --continue`. `message` (conflict and hook stops of the merge backend only; ops
 * validates it): the message for the stopped commit, given to git through msgs/<stopped-sha>
 * and the helper. At a conflict stop git commits the index with the original author. A
 * resolution that leaves nothing to commit drops the commit (`dropped: [sha]`).
 * @returns {Promise<RebaseResult>} {status: 'done', ...} | {status: 'stopped', state, dropped, hookOutput?}
 */
async function continue_(cwd, { message } = {}) {
  return step(cwd, await context(cwd), '--continue', { message });
}

/**
 * `rebase --skip`: the current commit's changes are left out; the rest continue. git resets the
 * tree for it (`reset --hard`): ops refuses it while other changes to tracked files exist.
 */
async function skip(cwd) {
  return step(cwd, await context(cwd), '--skip');
}

/**
 * `rebase --abort`; resolves null once no rebase is in progress any more (even when git reported
 * a failure after it had gone, e.g. a post-checkout hook), else the error to throw.
 */
async function runAbort(cwd, hashComments) {
  const err = await runRebase(cwd, ['--abort'], { hashComments }).then(() => null, (e) => e);
  if ((await repoState(cwd)) !== 'rebasing') {
    if (err) warn('rebase --abort reported a failure')(err);
    return null;
  }
  return err || kindError('in-progress', 'The rebase could not be aborted', { state: 'rebasing' });
}

/**
 * `rebase --abort`: the branch and worktree go back to orig-head, then our autostash comes back
 * and the state folder is removed. Not cancellable (runs under no signal). A rebase still in
 * progress after git's abort keeps the state folder and the autostash (a later Abort brings it
 * back) and throws git's error with `rebase`.
 * @returns {Promise<{status: 'aborted', branch, head, stash?, indexRestored?, resetFailed?}>}
 */
function abort(cwd) {
  return withSignal(undefined, async () => {
    const ctx = await context(cwd);
    const err = await runAbort(cwd, ctx.rebase.ours);
    if (err) throw Object.assign(err, { rebase: (await status(cwd)).rebase });
    const fin = await finish(cwd, ctx.gd);
    return { status: 'aborted', branch: ctx.branch, head: (await headState(cwd)).sha, ...fin };
  });
}

// ---------------------------------------------------------------- starting a rebase

/**
 * Non-interactive "Rebase <branch> onto <onto>" (§3.2) of the checked-out branch (or a detached
 * HEAD): rewrites merge-base(HEAD, onto)..HEAD onto `onto` (a full object id, validated by ops).
 * `ontoName` (a display name for the banner, or null) is recorded in meta.json.
 * - `onto` already in HEAD's history: {status: 'up-to-date', branch, head} without running git
 *   rebase (so no pre-rebase hook runs).
 * - `autostash` (default true): local changes go into our persistent autostash (§3.8), which
 *   comes back when the rebase finishes or is aborted, now or after a stop.
 * - A stop (conflicts, a failing hook) is a result: {status: 'stopped', state: RebaseState, dropped: []}.
 * - Finished (now or by a later continue / skip): {status: 'done', branch, before, after,
 *   fastForward, dropped: [sha], skippedCherryPicks, published, undoRecorded: false, stash?,
 *   indexRestored?, resetFailed?}.
 * Errors: in-progress (an earlier autostash waits), hook-failed (pre-rebase), dirty (autostash
 * off and git refused the changes), aborted (cancelled; with `rebase` when it left a stopped
 * rebase), or git's error; stashKept / stash when the autostash couldn't be re-applied.
 */
async function start(cwd, { onto, ontoName = null, autostash = true } = {}) {
  if (!oid(onto)) throw kindError('invalid-args', 'onto must be a full object id');
  const gd = await gitDir(cwd);
  const { sha: before, branch } = await headState(cwd);
  if (!before) throw kindError('invalid-args', 'There are no commits to rebase yet');
  if (await isAncestor(cwd, onto, before)) return { status: 'up-to-date', branch, head: before };
  await refusePendingAutostash(cwd);
  const fastForward = await isAncestor(cwd, before, onto);
  // What git will replay: the commits of HEAD not in onto, minus the ones whose patch onto
  // already has (git's default --no-reapply-cherry-picks), merges left out (--no-rebase-merges).
  const replayed = fastForward ? [] : ((await tryOut(cwd, ['rev-list', '--no-merges', '--cherry-pick', '--right-only', `${onto}...${before}`])) || '')
    .split('\n').filter((s) => OID.test(s));
  const total = fastForward ? 0 : await count(cwd, ['--no-merges', before, `^${onto}`]);
  rs.writeMeta(gd, {
    op: 'rebase', origHead: before, onto, ontoName: ontoName || null, branch, fastForward, total, replayed: replayed.length <= REPLAYED_MAX ? replayed : null,
  });
  const { err } = await runWithAutostash(cwd, `rebase of ${branch || 'HEAD'}`, autostash,
    () => runRebase(cwd, [...START_FLAGS, '--end-of-options', onto]));
  return outcome(cwd, startCtx(gd, branch, onto, before), err);
}

/** Max commits rebasePlan lists (an interactive rebase refuses more, R3; a plain one is fine). */
const PLAN_LIMIT = 500;

/**
 * Why an interactive rebase of `plan` can't start, or null (§4.2, F6): {kind, message} with kind
 * 'nothing' (no commits in the range), 'too-many' (more than PLAN_LIMIT), 'merge-commits',
 * 'root-commit'.
 */
function interactiveRefusal(plan) {
  if (plan.truncated) {
    return { kind: 'too-many', message: `An interactive rebase can edit at most ${PLAN_LIMIT} commits; this range has more` };
  }
  if (!plan.commits.length) return { kind: 'nothing', message: 'There are no commits to rebase' };
  if (plan.hasMerges) {
    return { kind: 'merge-commits', message: 'An interactive rebase is not available when the commits to rebase include a merge commit' };
  }
  if (plan.hasRoot) {
    return { kind: 'root-commit', message: 'An interactive rebase is not available when the commits to rebase include the first commit of the repository' };
  }
  return null;
}

/**
 * Which range commits each remote-tracking ref has: Map sha -> [short ref name] (in `refs`
 * order). One walk of everything the refs have that `upstream` hasn't (children come before
 * their parents), each commit passing its refs on to its parents.
 */
async function remoteContains(cwd, refs, upstream, inRange) {
  const res = new Map();
  if (!refs.length) return res;
  const raw = await out(cwd, ['rev-list', '--topo-order', '--parents', '--stdin'], { input: shaLines([...refs.map((r) => r.sha), `^${upstream}`]) });
  const sets = new Map();
  const add = (sha, from) => {
    let s = sets.get(sha);
    if (!s) {
      s = new Set();
      sets.set(sha, s);
    }
    for (const i of from) s.add(i);
  };
  refs.forEach((r, i) => add(r.sha, [i]));
  for (const line of raw.split('\n')) {
    const [sha, ...parents] = line.split(' ');
    const s = sets.get(sha);
    if (!s) continue;
    for (const p of parents) add(p, s);
    if (inRange.has(sha)) res.set(sha, [...s].sort((a, b) => a - b).map((i) => refs[i].short));
  }
  return res;
}

/**
 * rebasePlan (§4.2) for rebasing HEAD onto `onto` (default `upstream`), replaying upstream..HEAD.
 * Both are full object ids (ops resolves them). Read only.
 * @returns {Promise<{head, branch, upstream, onto, commits: [{sha, parents, subject, message,
 *   author, email, date, isMerge}], mergeBase, isAncestor, fastForward, hasMerges, hasRoot,
 *   published: [{sha, remoteRefs}], publishedRefs: string[], branchesInRange: string[],
 *   upstreamRef: string|null, defaultBranchOf: string|null, limit, truncated,
 *   interactiveRefusal: {kind, message}|null}>}
 *   commits: oldest first (the newest PLAN_LIMIT when truncated); published: range commits that
 *   some refs/remotes/* ref contains, with those refs' short names ('origin/feat');
 *   defaultBranchOf: the remote whose HEAD is the branch's upstream (the "main branch of origin");
 *   interactiveRefusal: why an interactive rebase of this range is refused (see interactiveRefusal).
 */
async function plan(cwd, { upstream, onto = upstream } = {}) {
  if (!oid(upstream) || !oid(onto)) throw kindError('invalid-args', 'upstream and onto must be full object ids');
  const { sha: head, branch } = await headState(cwd);
  if (!head) throw kindError('invalid-args', 'There are no commits to rebase yet');

  const raw = await out(cwd, [
    'rev-list', '--topo-order', `--max-count=${PLAN_LIMIT + 1}`, '--no-commit-header',
    '--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%s%x00%B%x00', head, `^${upstream}`,
  ]);
  const rows = parseNulRecords(raw, 7).filter(([sha]) => OID.test(sha));
  const truncated = rows.length > PLAN_LIMIT;
  const commits = rows.slice(0, PLAN_LIMIT).reverse().map(([sha, parents, author, email, date, subject, body]) => {
    const p = parents ? parents.split(' ') : [];
    return { sha, parents: p, subject, message: trimTrailingNewlines(body), author, email, date: Number(date), isMerge: p.length > 1 };
  });
  const inRange = new Set(commits.map((c) => c.sha));

  const mb = await tryOut(cwd, ['merge-base', head, onto]);
  const [ancestor, fastForward] = await Promise.all([isAncestor(cwd, onto, head), isAncestor(cwd, head, onto)]);

  // Remote-tracking refs that contain any commit of the range: they all contain one of its
  // oldest commits (those with no parent in the range), then which commits each has.
  const refs = [];
  if (commits.length) {
    const oldest = commits.filter((c) => !c.parents.some((p) => inRange.has(p)));
    const refsRaw = await out(cwd, [
      'for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)', ...oldest.flatMap((c) => ['--contains', c.sha]), 'refs/remotes',
    ]);
    for (const line of refsRaw.split('\n')) {
      const [ref, sha, symref] = line.split('\0');
      if (ref && !symref && OID.test(sha || '')) refs.push({ short: after(ref, PREFIX.REMOTES), sha });
    }
  }
  const published = await remoteContains(cwd, refs, upstream, inRange);

  const headsRaw = await out(cwd, ['for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/heads']);
  const branchesInRange = headsRaw.split('\n').map((l) => l.split('\0'))
    .map(([ref, sha]) => [branchOf(ref), sha])
    .filter(([name, sha]) => name && inRange.has(sha) && name !== branch)
    .map(([name]) => name);

  const up = branch ? await upstreamOf(cwd, branch).catch((e) => {
    if (e && e.kind === 'aborted') throw e;
    return null;
  }) : null;
  const upstreamRef = up ? after(up.ref, PREFIX.REMOTES) : null;
  let defaultBranchOf = null;
  if (up && up.remote && up.remote !== '.' && upstreamRef !== null) {
    const target = await tryOut(cwd, ['symbolic-ref', '-q', `refs/remotes/${up.remote}/HEAD`]);
    if (target && target.trim() === up.ref) defaultBranchOf = up.remote;
  }

  const res = {
    head, branch, upstream, onto,
    commits,
    mergeBase: mb && OID.test(mb.trim()) ? mb.trim() : null,
    isAncestor: ancestor,
    fastForward,
    hasMerges: commits.some((c) => c.isMerge),
    hasRoot: commits.some((c) => !c.parents.length),
    published: commits.filter((c) => published.has(c.sha)).map((c) => ({ sha: c.sha, remoteRefs: published.get(c.sha) })),
    publishedRefs: refs.map((r) => r.short),
    branchesInRange,
    upstreamRef,
    defaultBranchOf,
    limit: PLAN_LIMIT,
    truncated,
  };
  res.interactiveRefusal = interactiveRefusal(res);
  return res;
}

// ---------------------------------------------------------------- interactive rebase (R3)

/** Todo commands an interactive rebase we start may have (§4.3; `update-ref` is R5's opt-in). */
const TODO_ACTIONS = Object.freeze(['pick', 'reword', 'edit', 'squash', 'fixup', 'drop']);
/** Flags of an interactive start: START_FLAGS with -i instead of --merge (both are the merge backend). */
const INTERACTIVE_FLAGS = Object.freeze(['-i', ...START_FLAGS.filter((f) => f !== '--merge')]);

/** True when git refused the todo itself: a rebase in progress with no command done (§3.3, verified). */
function todoRejected(gd) {
  const dir = path.join(gd, 'rebase-merge');
  return isRealDir(dir) && !exists(path.join(dir, 'done'));
}

/**
 * Interactive rebase (§3.3) of the checked-out branch (or a detached HEAD): replays upstream..HEAD
 * onto `onto` (default `upstream`) as `todo` says. Everything is validated by ops
 * (rebaseInteractive): `todo` = [{cmd, sha}] oldest first, allow-listed commands and full shas of
 * exactly the plan's commits; `messages` = {[sha]: text} for each reword and each squash group's
 * last member. `head`: the HEAD the plan was built on (else kind 'stale'). `ontoName`: a display
 * name for the banner (meta.json).
 *
 * The backend writes the todo (<state>/todo) and the messages (<state>/msgs/<sha>); git runs our
 * helper as GIT_SEQUENCE_EDITOR (copies the todo) and GIT_EDITOR (supplies the messages).
 * - A stop (conflict, `edit`, a failing hook) is a result: {status: 'stopped', state, dropped, hookOutput?}.
 * - Finished (now or by a later continue / skip): {status: 'done', branch, before, after,
 *   fastForward: false, dropped: [sha], skippedCherryPicks: 0, published, undoRecorded: false,
 *   stash?, indexRestored?, resetFailed?}.
 * - A todo git (or the helper) refuses: the half-started rebase is aborted, the autostash comes
 *   back, and it throws kind 'invalid-todo' (with `rebase` when that abort failed: the rebase is
 *   then still in progress, with its autostash).
 * Other errors as start(): in-progress, hook-failed (pre-rebase), dirty, aborted, symlink.
 */
async function startInteractive(cwd, { upstream, onto = upstream, ontoName = null, todo, messages = {}, autostash = true, head } = {}) {
  if (!oid(upstream) || !oid(onto)) throw kindError('invalid-args', 'upstream and onto must be full object ids');
  if (!Array.isArray(todo) || !todo.length || !todo.every((l) => l && TODO_ACTIONS.includes(l.cmd) && oid(l.sha) === l.sha)) {
    throw kindError('invalid-args', 'The rebase todo must be a list of allowed commands with full object ids');
  }
  const msgs = Object.entries(messages || {});
  // messageRule's type and content checks (a blank one is ops' refusal, not ours).
  if (!msgs.every(([sha, text]) => oid(sha) === sha && !['type', 'content'].includes(messageProblem(text)))) {
    throw kindError('invalid-args', 'Invalid rebase messages');
  }
  const gd = await gitDir(cwd);
  const { sha: before, branch } = await headState(cwd);
  if (!before) throw kindError('invalid-args', 'There are no commits to rebase yet');
  if (head && head !== before) throw kindError('stale', 'The branch moved since you opened this; review and try again', { head: before });
  await refusePendingAutostash(cwd);

  const lines = todo.map((l) => ({ cmd: l.cmd, sha: l.sha }));
  rs.writeMeta(gd, {
    op: 'rebase-interactive', origHead: before, onto, ontoName: ontoName || null, branch, todo: lines, renamed: msgs.map(([sha]) => sha),
  });
  try {
    const sd = stateDirOf(gd);
    writeStateFile(sd, 'todo', lines.map((l) => `${l.cmd} ${l.sha}\n`).join(''));
    for (const [sha, text] of msgs) writeStateFile(path.join(sd, 'msgs'), sha, text);
  } catch (e) {
    rs.clearState(gd);
    throw e;
  }

  const { err } = await runWithAutostash(cwd, `rebase of ${branch || 'HEAD'}`, autostash,
    () => runRebase(cwd, [...INTERACTIVE_FLAGS, '--onto', onto, '--end-of-options', upstream], { env: helperEnv(gd, { todo: true }) }));
  // A cancel before the first command also leaves no `done`: that is a stopped rebase (outcome).
  if (err && err instanceof GitError && err.kind !== 'aborted' && todoRejected(gd)) {
    // git refused our todo and left a rebase with no command done: undo that, then the autostash.
    await withSignal(undefined, async () => {
      if (await runAbort(cwd, true)) {
        throw tagError(err, 'invalid-todo', {
          message: 'git refused the rebase plan, and the rebase it started could not be aborted: abort it, then try again',
          rebase: (await status(cwd)).rebase,
        });
      }
      const fin = await finish(cwd, gd);
      throw tagError(err, 'invalid-todo', { message: 'git refused the rebase plan; nothing was changed', ...keptFields(fin) });
    });
  }
  if (gitErrors.unclassified(err) && gitErrors.matches(err, 'helperRefused') && (await repoState(cwd)) === 'clean') {
    tagError(err, 'invalid-todo', { message: 'The rebase plan was refused; nothing was changed' });
  }
  return outcome(cwd, startCtx(gd, branch, onto, before), err);
}

// ---------------------------------------------------------------- Pull (rebase)

/**
 * The rebase step of Pull (rebase), onto the upstream's commit `onto`, with our persistent
 * autostash: local changes are stashed and recorded in AUTOSTASH_REF. A clean finish re-applies
 * them; a stop (conflicts) keeps the stash and the ref, so Continue / Abort bring them back
 * later. Throws kind 'conflicts' (with `rebase`, and stashKept / stash when there was one) when
 * git stopped, 'in-progress' when an earlier autostash still waits, 'hook-failed' for a
 * pre-rebase refusal, 'stash-conflict' when the changes couldn't be re-applied. Returns
 * {indexRestored?: false}.
 */
async function pullRebase(cwd, { onto, ontoName, branch, before }) {
  const gd = await gitDir(cwd);
  await refusePendingAutostash(cwd);
  rs.writeMeta(gd, { op: 'pull', origHead: before, onto, ontoName: ontoName || null, branch });
  const { stash, err } = await runWithAutostash(cwd, `rebase of ${branch || 'HEAD'}`, true,
    () => runRebase(cwd, [...START_FLAGS, '--end-of-options', onto]));
  const kept = keptFields({ stash: stash && { sha: stash } });
  let res;
  try {
    res = await outcome(cwd, startCtx(gd, branch, onto, before), err);
  } catch (e) {
    throw e.rebase ? Object.assign(e, kept) : e;
  }
  if (res.status === 'stopped') {
    const e = err && !err.kind ? tagError(err, 'conflicts') : kindError('conflicts', 'The rebase stopped');
    throw Object.assign(e, kept, { rebase: res.state });
  }
  if (res.stash) {
    const why = KEPT_WHY[res.stash.reason] || KEPT_WHY.conflict;
    throw kindError('stash-conflict', `Your local changes couldn't be re-applied (${why}); they are kept in the stash`, { ...keptFields(res), reason: res.stash.reason });
  }
  return res.indexRestored === false ? { indexRestored: false } : {};
}

module.exports = {
  REBASE_CONFIG, START_FLAGS, HELPER, PLAN_LIMIT,
  start, plan, startInteractive, interactiveRefusal, todoGroups, TODO_ACTIONS,
  continue_, skip, abort, pullRebase, helperEnv, refuseExec,
};
