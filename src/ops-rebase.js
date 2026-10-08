'use strict';
// Argument checks of the merge / rebase ops (docs/plans/rebase.md §4.3), split out of ops.js:
// merge / rebase targets, whether one may start, the interactive todo (the security boundary: it
// comes from the renderer, and only validated {cmd, sha} pairs reach the todo file), and the
// refusals of Continue / Skip / Abort, Restore and Commit and Merge. Nothing here changes the
// repo. `checks.<op>(repo, ...rendererArgs)` is the `check` half of ops.js's op of that name: it
// returns the argument list of its `act`.
const git = require('./git');
const rebase = require('./rebase');
const merge = require('./merge');
const { pendingAutostashError } = require('./autostash');
const { messageRule } = require('./message-rule');
const { isAncestor } = require('./git-reads');
const { kindError } = require('./exec');
const { OID, sha7 } = require('./gitref');

const {
  invalid, isObj, str, sha, opts, relPath, bool,
} = require('./op-validators');

// ---------------------------------------------------------------- targets and starts

// Where a merge / rebase target may point: a local or remote branch, a tag, or a commit.
const TARGET_PREFIXES = Object.freeze([['refs/heads/', 'local'], ['refs/remotes/', 'remote'], ['refs/tags/', 'tag']]);

/**
 * A merge / rebase target from the renderer, resolved to {sha, kind, name, ref} so that only the
 * full commit id ever reaches git (§3.2, §7):
 * - a full object id: {kind: 'commit', name: <sha7>, ref: null};
 * - a full ref name 'refs/heads/x' | 'refs/remotes/origin/x' | 'refs/tags/v1' that exists
 *   exactly (never guessed): kind 'local' | 'remote' | 'tag', name 'x' | 'origin/x' | 'v1';
 * - a short name ('feat', 'origin/feat', 'v1'): exactly one of refs/heads/, refs/remotes/ and
 *   refs/tags/ must have it; a name more than one has (a local branch called 'origin/main' next
 *   to the remote branch) is refused with kind 'ambiguous' (and `refs`: the full names to pick
 *   from), where git itself would silently pick one;
 * - an abbreviated object id (7+ hex digits) that no ref is named like: kind 'commit'.
 * Anything else (options, '..' ranges, '@{…}', a tree): kind 'invalid-args'.
 */
async function target(repo, value, what) {
  const s = str(value, what);
  const bad = () => invalid(`${what} is not a branch, tag or commit: '${s}'`);
  if (s.startsWith('-') || /[\s~^:?*[\\]|\.\.|@\{/.test(s)) throw bad();
  const commitOf = async (ref) => {
    const oid = await git.resolveCommit(repo, ref);
    if (!oid) throw bad();
    return oid;
  };
  if (OID.test(s)) return { sha: await commitOf(s), kind: 'commit', name: sha7(s), ref: null };
  const full = TARGET_PREFIXES.find(([p]) => s.startsWith(p) && s.length > p.length);
  if (full) {
    if (!(await git.refExists(repo, s))) throw bad();
    return { sha: await commitOf(s), kind: full[1], name: s.slice(full[0].length), ref: s };
  }
  if (s.startsWith('refs/')) throw bad();
  const found = [];
  for (const [p, kind] of TARGET_PREFIXES) if (await git.refExists(repo, p + s)) found.push({ ref: p + s, kind });
  if (found.length > 1) {
    throw kindError('ambiguous', `'${s}' names more than one ref (${found.map((f) => f.ref).join(', ')}); pick one`, { refs: found.map((f) => f.ref) });
  }
  if (found.length === 1) return { sha: await commitOf(found[0].ref), kind: found[0].kind, name: s, ref: found[0].ref };
  if (/^[0-9a-f]{7,63}$/.test(s)) {
    const oid = await commitOf(s);
    return { sha: oid, kind: 'commit', name: sha7(oid), ref: null };
  }
  throw bad();
}

const OP_NAMES = Object.freeze({ merging: 'merge', rebasing: 'rebase' });
const inProgress = (state) => {
  const op = Object.hasOwn(OP_NAMES, state) ? OP_NAMES[state] : 'operation';
  return kindError('in-progress', `Finish or abort the ${op} in progress first`, { state });
};

const stale = (st, what) => kindError('stale', `The ${what} changed since you opened this; review and try again`, { head: st.oid });

/**
 * Status of a repo where a merge / rebase may start (§4.3): state clean (else kind
 * 'in-progress' with `state`), no autostash of an earlier rebase / merge waiting (kind
 * 'in-progress', state 'autostash'), a born HEAD (else 'invalid-args'), HEAD at `expectHead`
 * and the checked-out branch `expectBranch` (a short name, or null: a detached HEAD) when given
 * (else 'stale'), and no local changes to tracked files when `autostash` is off (else 'dirty',
 * with `paths` capped at 20).
 */
async function startable(repo, { expectHead, expectBranch, autostash }) {
  const want = expectHead == null ? null : sha(expectHead, 'expectHead');
  const wantBranch = expectBranch === undefined || expectBranch === null ? expectBranch : str(expectBranch, 'expectBranch');
  const st = await git.status(repo);
  if (st.state !== 'clean') throw inProgress(st.state);
  if (st.pendingAutostash) throw pendingAutostashError(st.pendingAutostash);
  if (!st.oid) throw invalid('There are no commits yet');
  if (want && want !== st.oid) throw stale(st, 'branch moved');
  if (wantBranch !== undefined && wantBranch !== st.branch) throw stale(st, 'checked-out branch');
  if (!autostash) refuseDirty(await trackedPaths(repo), 'Commit or stash your local changes first');
  return st;
}

/**
 * Paths with changes to tracked files (git.trackedChanges): staged, unstaged and conflicted
 * (`unstagedOnly`: unstaged and conflicted). Untracked files and submodules never count.
 */
const trackedPaths = async (repo, { unstagedOnly = false } = {}) => [...new Set(await git.trackedChanges(repo, { unstagedOnly }))];

/** Kind 'dirty' ({paths: the first 20, count}) when `paths` isn't empty. */
function refuseDirty(paths, message) {
  if (paths.length) throw kindError('dirty', message, { paths: paths.slice(0, 20), count: paths.length });
}

/** `autostash` option: true unless exactly false. */
function autostashOpt(x) {
  if (x !== undefined && x !== null && typeof x !== 'boolean') throw invalid('autostash must be a boolean');
  return x !== false;
}

// ---------------------------------------------------------------- a rebase / merge in progress

/** Status of a repo that is mid-rebase; else kind 'not-rebasing' (with `state`). */
async function rebasing(repo) {
  const st = await git.status(repo);
  if (!st.rebase) throw kindError('not-rebasing', 'No rebase is in progress', { state: st.state });
  return st;
}

/** Status of a repo that is mid-merge; else kind 'not-merging' (with `state`). */
async function merging(repo) {
  const st = await git.status(repo);
  if (st.state !== 'merging') throw kindError('not-merging', 'No merge is in progress', { state: st.state });
  return st;
}

/** Kind 'conflicts' (with `count`) while `st` has conflicted files. */
function refuseConflicts(st) {
  if (st.conflicted.length) {
    throw kindError('conflicts', `Resolve and mark all conflicted files first (${st.conflicted.length} conflicted)`, { count: st.conflicted.length, state: st.state });
  }
}

/**
 * Kind 'rebasing' while a rebase is stopped at a commit it is replaying (a conflict, resolved or
 * not, or a pick that became empty): commit / commitAll there would record the user as the
 * author. An edit stop, or a stop between commits (break, exec), allows them.
 */
function refuseAtPickStop(st) {
  const r = st.rebase;
  if (!r || r.stop === 'edit') return;
  if (r.stop === 'conflict' || r.stop === 'empty' || r.stoppedSha) {
    throw kindError('rebasing', 'Use Continue Rebase to commit the resolved changes', { state: st.state, stop: r.stop });
  }
}

/** An optional message for Continue / Commit and Merge: undefined, or one messageRule accepts. */
const optionalMessage = (x) => (x === undefined || x === null ? undefined : messageRule(x));

// ---------------------------------------------------------------- interactive rebase todo (§4.3)

const TODO_KEYS = new Set(['action', 'sha']);
/** An action worth echoing in an error message (the renderer's string, only when harmless). */
const shownAction = (a) => (typeof a === 'string' && /^[a-z-]{1,20}$/.test(a) ? ` '${a}'` : '');

/**
 * The todo's shape, before anything asks the repo: an array of at most PLAN_LIMIT plain objects
 * with exactly `action` (allow-listed: exec, break, label, reset, merge, update-ref and anything
 * else are refused) and `sha` (a full object id). Returns [{cmd, sha}] (kind 'invalid-args').
 */
function todoShape(todo) {
  if (!Array.isArray(todo)) throw invalid('todo must be a list');
  if (!todo.length) throw invalid('todo must not be empty');
  if (todo.length > rebase.PLAN_LIMIT) throw invalid(`todo must have at most ${rebase.PLAN_LIMIT} entries`);
  return todo.map((e, i) => {
    const proto = isObj(e) ? Object.getPrototypeOf(e) : undefined;
    if (!isObj(e) || (proto !== Object.prototype && proto !== null)) throw invalid(`todo entry ${i + 1} must be an object`);
    const keys = Reflect.ownKeys(e);
    if (keys.some((k) => !TODO_KEYS.has(k))) throw invalid(`todo entry ${i + 1} may only have action and sha`);
    const { action } = e;
    if (typeof action !== 'string' || !rebase.TODO_ACTIONS.includes(action)) throw invalid(`Unsupported rebase command${shownAction(action)}`);
    return { cmd: action, sha: sha(e.sha, `todo entry ${i + 1}: sha`) };
  });
}

/**
 * `messages`: undefined or a plain object of {[full sha]: text}; each text a non-blank string
 * (else kind 'empty-message') of at most MESSAGE_MAX bytes with no NUL (else 'invalid-args').
 * Returns a null-prototype copy.
 */
function messagesShape(messages) {
  const res = Object.create(null);
  if (messages === undefined || messages === null) return res;
  const proto = isObj(messages) ? Object.getPrototypeOf(messages) : undefined;
  if (!isObj(messages) || (proto !== Object.prototype && proto !== null)) throw invalid('messages must be an object');
  const keys = Reflect.ownKeys(messages);
  if (keys.length > rebase.PLAN_LIMIT) throw invalid(`messages must have at most ${rebase.PLAN_LIMIT} entries`);
  for (const k of keys) {
    if (typeof k !== 'string' || !OID.test(k)) throw invalid('messages keys must be full object ids');
    res[k] = messageRule(messages[k], { what: `message of ${sha7(k)}`, empty: `The message of ${sha7(k)} cannot be empty` });
  }
  return res;
}

/**
 * The todo checked against the plan recomputed server-side (§4.3 steps 3–8): every plan commit
 * exactly once and nothing else (kind 'invalid-todo'), the first kept entry not squash / fixup
 * ('invalid-todo'), a message for each reword and each squash group (keyed by its last member,
 * the commit git completes the group with) and for nothing else ('empty-message' when missing,
 * 'invalid-args' for another key), and something to change ('nothing': every commit picked in
 * the original order onto the commit it is already on). Dropping everything is allowed.
 * Returns [{cmd, sha}] oldest first.
 */
function interactiveTodo(plan, lines, msgs) {
  const inPlan = new Set(plan.commits.map((c) => c.sha));
  const seen = new Set();
  for (const { sha: s } of lines) {
    if (!inPlan.has(s)) throw kindError('invalid-todo', `${sha7(s)} is not one of the commits being rebased`);
    if (seen.has(s)) throw kindError('invalid-todo', `${sha7(s)} is listed more than once`);
    seen.add(s);
  }
  const missing = plan.commits.filter((c) => !seen.has(c.sha));
  if (missing.length) throw kindError('invalid-todo', `The plan leaves out ${missing.length} commit(s) (${sha7(missing[0].sha)}…); drop them explicitly`);

  const first = lines.find((l) => l.cmd !== 'drop');
  if (first && (first.cmd === 'squash' || first.cmd === 'fixup')) {
    throw kindError('invalid-todo', "The oldest commit can't be squashed: there is nothing before it to combine with");
  }

  const need = new Set();
  for (const g of rebase.todoGroups(lines)) {
    if (g.reword) need.add(g.head);
    if (g.squash) need.add(g.members[g.members.length - 1]);
  }
  for (const k of Object.keys(msgs)) {
    if (!need.has(k)) throw invalid(`A message was given for ${sha7(k)}, which is neither reworded nor the last commit of a squash`);
  }
  for (const k of need) if (!Object.hasOwn(msgs, k)) throw kindError('empty-message', `The commit ${sha7(k)} needs a message`);

  const unchanged = lines.every((l, i) => l.cmd === 'pick' && l.sha === plan.commits[i].sha);
  if (unchanged && plan.commits[0].parents[0] === plan.onto) throw kindError('nothing', 'Nothing to change: change an action or the order');
  return lines;
}

// ---------------------------------------------------------------- the checks, per op

const checks = {
  merge: async (repo, t, o) => {
    const { ff = 'ff', autostash, expectHead, expectBranch } = opts(o);
    if (!merge.FF_MODES.includes(ff)) throw invalid(`ff must be one of ${merge.FF_MODES.join(', ')}`);
    const auto = autostashOpt(autostash);
    const st = await startable(repo, { expectHead, expectBranch, autostash: auto });
    const tg = await target(repo, t, 'target');
    if (ff === 'ff-only' && !(await isAncestor(repo, st.oid, tg.sha)) && !(await isAncestor(repo, tg.sha, st.oid))) {
      throw kindError('not-fast-forward', `${tg.name} can't be fast-forwarded to: the branches have diverged`);
    }
    return [tg, { ff, autostash: auto }];
  },
  rebase: async (repo, onto, o) => {
    const { autostash, expectHead, expectBranch } = opts(o);
    const auto = autostashOpt(autostash);
    await startable(repo, { expectHead, expectBranch, autostash: auto });
    const tg = await target(repo, onto, 'onto');
    return [{ onto: tg.sha, ontoName: tg.kind === 'commit' ? null : tg.name, autostash: auto }];
  },
  rebaseInteractive: async (repo, range, todo, o) => {
    const { upstream, onto } = opts(range);
    const { messages, expectHead, expectBranch, autostash, updateRefs } = opts(o);
    if (updateRefs !== undefined && updateRefs !== null && typeof updateRefs !== 'boolean') throw invalid('updateRefs must be a boolean');
    if (updateRefs === true) throw invalid('updateRefs is not yet supported');
    const auto = autostashOpt(autostash);
    const entries = todoShape(todo);
    const msgs = messagesShape(messages);
    await startable(repo, { expectHead, expectBranch, autostash: auto });
    const up = await target(repo, upstream, 'upstream');
    const on = onto == null ? up : await target(repo, onto, 'onto');
    const plan = await rebase.plan(repo, { upstream: up.sha, onto: on.sha });
    if (plan.interactiveRefusal) throw kindError(plan.interactiveRefusal.kind, plan.interactiveRefusal.message);
    const lines = interactiveTodo(plan, entries, msgs);
    return [{
      upstream: up.sha, onto: on.sha, ontoName: on.kind === 'commit' ? null : on.name, todo: lines, messages: msgs, autostash: auto, head: plan.head,
    }];
  },
  resolveWith: async (repo, file, side) => {
    const p = relPath(file);
    if (side !== 'ours' && side !== 'theirs') throw invalid("side must be 'ours' or 'theirs'");
    const st = await git.status(repo);
    if (!st.conflicted.some((f) => f.path === p)) throw kindError('not-conflicted', `'${p}' is not a conflicted file`, { state: st.state });
    return [p, side];
  },
  markAllResolved: async (repo) => {
    const st = await git.status(repo);
    if (!st.conflicted.length) throw kindError('nothing', 'There are no conflicted files', { state: st.state });
    return [];
  },
  // A message only where git commits the stopped commit anew: a conflict stop, or a hook stop
  // (the hook refused its commit). The apply backend never takes one (it keeps each message).
  // Both refused (kind 'rebase-exec', rebase.refuseExec) while the rest of the todo runs commands.
  rebaseContinue: async (repo, o) => {
    const message = optionalMessage(opts(o).message);
    const st = await rebasing(repo);
    rebase.refuseExec(st.rebase);
    refuseConflicts(st);
    refuseDirty(await trackedPaths(repo, { unstagedOnly: true }), 'Stage or discard your unstaged changes before continuing the rebase');
    if (message !== undefined) {
      if (st.rebase.backend !== 'merge') throw invalid("This rebase keeps each commit's message (it was started with git's apply backend), so a message can't be given");
      if (st.rebase.stop !== 'conflict' && st.rebase.stop !== 'hook') throw invalid('A message can only be given at a conflict or hook stop');
    }
    return [{ message }];
  },
  // git's --skip resets the tree (`reset --hard`): refused while tracked files have changes other
  // than the conflicted ones and the ones the stopped commit touches (what Skip is meant to
  // throw away). At an edit stop the commit is already made: Skip wouldn't leave it out.
  rebaseSkip: async (repo) => {
    const st = await rebasing(repo);
    const r = st.rebase;
    rebase.refuseExec(r);
    if (r.stop === 'edit') {
      throw invalid('Skip is not available at an edit stop: the commit is already applied. Continue keeps it; to leave it out, abort and drop it in a new interactive rebase');
    }
    const stopped = r.stoppedSha || (r.current && r.current.sha);
    const skipped = new Set([...st.conflicted.map((f) => f.path), ...(stopped ? await git.commitPaths(repo, stopped) : [])]);
    refuseDirty((await trackedPaths(repo)).filter((p) => !skipped.has(p)),
      'Skip throws away every change to tracked files: commit, stash or discard your other changes first');
    return [];
  },
  rebaseAbort: async (repo) => {
    await rebasing(repo);
    return [];
  },
  restoreAutostash: async (repo, o) => {
    const keep = bool(opts(o).keep);
    const st = await git.status(repo);
    if (st.state !== 'clean') throw inProgress(st.state);
    if (!st.pendingAutostash) throw kindError('nothing', 'There is no stash from before a rebase to restore');
    if (!keep) refuseDirty(await trackedPaths(repo), 'Commit, stash or discard your changes to tracked files before restoring the stash');
    return [{ keep }];
  },
  mergeCommit: async (repo, o) => {
    const message = optionalMessage(opts(o).message);
    const st = await merging(repo);
    refuseConflicts(st);
    if (st.merge && st.merge.autostash) {
      refuseDirty(await trackedPaths(repo, { unstagedOnly: true }), 'Stage or discard your unstaged changes before committing the merge: your stashed changes come back then');
    }
    return [{ message }];
  },
  mergeAbort: async (repo) => {
    await merging(repo);
    return [];
  },
};

/**
 * The rebasePlan read op ({upstream, onto?, interactive?}): see ops.js READ.rebasePlan.
 * `upstream` / `onto` are targets (target()); `interactive: true` also refuses with the plan's
 * interactiveRefusal kind, the plan attached as `plan`.
 */
async function rebasePlan(repo, o) {
  const { upstream, onto, interactive } = opts(o);
  const up = await target(repo, upstream, 'upstream');
  const on = onto == null ? up : await target(repo, onto, 'onto');
  const plan = await rebase.plan(repo, { upstream: up.sha, onto: on.sha });
  if (bool(interactive) && plan.interactiveRefusal) throw kindError(plan.interactiveRefusal.kind, plan.interactiveRefusal.message, { plan });
  return plan;
}

module.exports = { checks, rebasePlan, inProgress, refuseAtPickStop };
