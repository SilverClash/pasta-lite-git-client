'use strict';
// What a failed git command's text means: one named table of the stderr / stdout patterns the
// modules classify git's failures by, and the helpers that apply it. Pure (nothing here runs
// git): whether a hook exists is asked by the caller (hooks.hookRefused).
//
// A rule only ever classifies an unclassified GitError (no `kind` yet): a cancel, a timeout or a
// kind set further down is never overwritten.
const { GitError, tagError } = require('./exec');
const { HELPER_REFUSED } = require('./namespace');

/**
 * Rules: {re (one RegExp or a list: any), from, kind?}. `from` is the text tested: 'stderr',
 * 'stdout', 'both' (stderr then stdout) or 'message' (err.message, which for a GitError is git's
 * trimmed text). `kind` is what classify() tags; rules without one are tests only.
 */
const RULES = Object.freeze({
  // The branch is checked out in another worktree: checkout / switch ("is already used by worktree
  // at", older git "is already checked out at"), branch -d ("cannot delete branch 'x' used by
  // worktree at", "checked out at"), a fetch refspec writing it ("refusing to fetch into branch
  // 'refs/heads/x' checked out at").
  checkedOutElsewhere: {
    re: /refusing to fetch into (?:current )?branch|is already (?:used|checked out) by worktree at|(?:checked out|used by worktree) at/i,
    from: 'stderr', kind: 'checked-out-elsewhere',
  },
  notFastForward: { re: /not possible to fast-forward/i, from: 'both', kind: 'not-fast-forward' },
  // Local changes (or untracked files) in the way of a checkout, switch, merge or pick.
  overwritten: { re: /would be overwritten by|Please commit your changes or stash them/i, from: 'both', kind: 'dirty' },
  // `rebase` refusing to start over changes (autostash off).
  uncommittedChanges: { re: /You have unstaged changes|Your index contains uncommitted changes/i, from: 'both', kind: 'dirty' },
  unrelatedHistories: { re: /refusing to merge unrelated histories/i, from: 'both', kind: 'unrelated-histories' },
  notFullyMerged: { re: /not fully merged/i, from: 'stderr', kind: 'not-merged' },
  // Credential failures: only fatal: / remote: lines (anchored), never ref names or hook output.
  auth: {
    re: [
      /^fatal: Authentication failed/m,
      /^fatal: could not read (Username|Password)/m,
      /^fatal: .*terminal prompts disabled/m,
      /^fatal: .*The requested URL returned error: 40[13]\b/m,
      /^remote: .*\b403\b/m,
      /^remote: (Invalid username or password|Permission to \S+ denied)/m,
      /Permission denied \(publickey/,
    ],
    from: 'stderr', kind: 'auth',
  },
  // remote.<r>.mirror: git pushes every ref, and refuses the explicit refspec we always pass.
  mirrorPush: { re: /--mirror can't be combined with refspecs/, from: 'stderr', kind: 'mirror-repo' },
  // setUpstream: no fetch refspec of the remote maps a branch to refs/remotes/<remote>/.
  noTrackingRefspec: { re: /is not a branch/, from: 'stderr', kind: 'unsupported' },
  // `git worktree remove` / `lock` / `unlock` (src/git.js). Dirty: modified or untracked files,
  // or submodules (both only go with --force). Locked: with or without a reason ("cannot remove a
  // locked working tree, lock reason: x" / "...;"); the app never passes -f -f. Main: `remove`
  // ("'<path>' is a main working tree") and `lock` / `unlock`. A path git doesn't list:
  // "'<path>' is not a working tree".
  worktreeDirty: {
    re: [/contains modified or untracked files/i, /containing submodules cannot be moved or removed/i],
    from: 'stderr', kind: 'worktree-dirty',
  },
  worktreeLocked: { re: /cannot (?:remove|move) a locked working tree/i, from: 'stderr', kind: 'worktree-locked' },
  mainWorktree: { re: /is a main working tree|main working tree cannot be locked or unlocked/i, from: 'stderr', kind: 'main-worktree' },
  notAWorktree: { re: /is not a working tree/i, from: 'stderr', kind: 'not-found' },
  // `stash apply --index` that can only apply without the index.
  applyWithoutIndex: { re: /try without --index/i, from: 'stderr' },
  // git prints these on stdout (hook output always goes to stderr, so a hook can't fake them).
  nothingToCommit: { re: /^(nothing to commit|nothing added to commit|no changes added to commit)\b/m, from: 'stdout', kind: 'nothing-to-commit' },
  unmerged: { re: /unmerged files|unresolved conflict/i, from: 'stderr', kind: 'conflicts' },
  signingFailed: { re: /gpg failed to sign|signing failed|failed to write commit object|ssh-keygen|couldn't load public key|error: load key/i, from: 'both' },
  // Why git stops a pick or a merge without conflicts and without any hook being at fault: files
  // in the way (untracked or changed ones), a todo command git couldn't run (it reschedules it).
  notAHook: {
    re: [/would be overwritten by|Please commit your changes or stash them/i, /Could not execute the todo command|untracked working tree files? would be/i],
    from: 'both',
  },
  // Our rebase editor helper (src/rebase-editor.js) refused the todo or a message.
  helperRefused: { re: new RegExp(HELPER_REFUSED), from: 'both' },
  // Opening a folder.
  dubiousOwnership: { re: /dubious ownership/i, from: 'message', kind: 'unsafe-repo' },
  notARepo: { re: /not a git repository|bare repository|must be run in a work tree/i, from: 'message' },
  bareRefused: { re: /cannot use bare repository/i, from: 'message' },
});

/** The text rule field `from` names (see RULES). */
function textOf(err, from) {
  if (!err) return '';
  if (from === 'message') return String(err.message || '');
  if (from === 'stdout') return String(err.stdout || '');
  if (from === 'both') return `${err.stderr || ''}\n${err.stdout || ''}`;
  return String(err.stderr || '');
}

/** True when `err`'s text matches rule `name` (any error object; see unclassified). */
function matches(err, name) {
  const rule = RULES[name];
  if (!rule) throw new TypeError(`git-errors: no rule '${name}'`);
  const text = textOf(err, rule.from);
  return (Array.isArray(rule.re) ? rule.re : [rule.re]).some((re) => re.test(text));
}

/** True for a GitError no one has given a kind yet (only those are classified). */
const unclassified = (err) => err instanceof GitError && !err.kind;

/** The kind of the first of rules `names` that the unclassified GitError `err` matches, or null. */
function kindFor(err, ...names) {
  if (!unclassified(err)) return null;
  const hit = names.find((n) => matches(err, n));
  if (hit && !RULES[hit].kind) throw new TypeError(`git-errors: rule '${hit}' has no kind`);
  return hit ? RULES[hit].kind : null;
}

/** `err` tagged with kindFor(err, ...names) (and `extra`), or `err` unchanged when none matches. */
function classify(err, names, extra = {}) {
  const kind = kindFor(err, ...names);
  return kind ? tagError(err, kind, extra) : err;
}

/**
 * What stopped a rebase or merge with no conflicts, from git's text: 'signing' (a signing
 * failure), 'other' (a known reason no hook is behind: files in the way, a todo command git
 * couldn't run) or null (it may have been a hook: the caller checks whether one exists).
 */
function failureKind(err) {
  if (matches(err, 'signingFailed')) return 'signing';
  return matches(err, 'notAHook') ? 'other' : null;
}

/** `ref` of every `!` (rejected) line of `fetch --porcelain` output. */
const rejectedFetchRefs = (stdout) => String(stdout || '').split('\n')
  .map((l) => /^! \S+ \S+ (.+)$/.exec(l))
  .filter(Boolean)
  .map((m) => m[1]);

/**
 * Classify a failed `push --porcelain`: the ref status lines (`!\t<src>:<dst>\t[flag] (reason)`
 * on stdout) are authoritative; only without them is stderr checked for auth failures, anchored
 * to fatal:/remote: lines so branch names or hook output can't trigger a false match.
 * @returns {{kind: string, extra: object}|null}
 */
function classifyPush(err) {
  const stderr = String(err.stderr || '');
  const rejected = String(err.stdout || '').split('\n')
    .map((l) => /^!\t([^\t]*)\t\[([^\]]+)\](?: \((.*)\))?$/.exec(l))
    .filter(Boolean);
  if (rejected.length) {
    const [, refspec, flag, reason = ''] = rejected[0];
    const extra = { refspec, reason };
    if (flag === 'remote rejected') {
      const remoteMessage = stderr.split('\n').filter((l) => l.startsWith('remote:')).map((l) => l.slice(7).trim()).filter(Boolean).join('\n');
      return { kind: 'rejected-hook', extra: { ...extra, remoteMessage } };
    }
    if (reason === 'non-fast-forward') return { kind: 'rejected-behind', extra };
    if (reason === 'fetch first' || reason === 'stale info') return { kind: 'rejected-stale', extra };
    return { kind: 'rejected', extra };
  }
  if (matches(err, 'auth')) return { kind: 'auth', extra: {} };
  if (matches(err, 'mirrorPush')) {
    return { kind: 'mirror-repo', extra: { message: 'This remote is set up as a mirror (remote.<name>.mirror): git would push every ref, deleting what the remote has and this repository lacks, so pushing one branch is not possible' } };
  }
  return null;
}

module.exports = {
  RULES, textOf, matches, unclassified, kindFor, classify, failureKind, rejectedFetchRefs, classifyPush,
};
