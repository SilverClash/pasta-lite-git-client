/*
 * Pasta Lite - the catalogue of error kinds (`err.kind`) the git layer and main set.
 *
 * Pure, dependency-free. Works in Node (`require('./src/error-kinds.js')`) and in the browser as
 * a plain <script> (exposes `window.PLErrorKinds`).
 *
 * KINDS: {NAME: 'kind-string'} (frozen); MEANING: {'kind-string': one line} (frozen);
 * isKind(s): true for a catalogued kind. The strings are the contract with the renderer
 * (Components.util.EXPECTED_KINDS) and the logs; test/error-kinds.test.js fails when a module
 * (src/, main/ or main.js) sets a kind that isn't listed here, or when an entry is no longer set anywhere.
 */
(function (exports) {
  'use strict';

  const MEANING = Object.freeze({
    aborted: 'the operation was cancelled (its git processes were killed)',
    ambiguous: 'a short name names more than one ref (`refs`: the full names to pick from)',
    auth: 'the remote refused the credentials',
    'bare-repo': 'the operation needs a working tree and this is a bare repository',
    binary: 'lines of a binary file can\'t be staged or discarded',
    busy: 'undo / redo while an operation is in progress (`state`)',
    'checked-out-elsewhere': 'the branch is checked out in another worktree',
    conflict: 'a hunk or line action on an unmerged path',
    conflicts: 'there are (or the operation left) conflicted files (`count`)',
    'current-branch': 'the branch to delete is the checked-out one',
    'current-worktree': 'the worktree is the one this tab has open, or contains it',
    detached: 'pull / push need a branch and HEAD is detached',
    dirty: 'local changes to tracked files are in the way (`paths`, `count`)',
    'embedded-bare': 'a bare repository inside another repository\'s working tree is not opened',
    'empty-message': 'a commit message is empty or blank',
    forbidden: 'the IPC sender may not call that channel',
    'hook-failed': 'a hook refused the operation (message: its output)',
    'in-progress': 'another operation is in progress (`state`; \'autostash\' while an autostash waits)',
    'invalid-args': 'the renderer\'s arguments were refused by validation',
    'invalid-todo': 'an interactive rebase todo was refused',
    'local-exists': 'a local branch of that name exists and tracks something else',
    'main-worktree': 'the main worktree or a bare repository can\'t be deleted, locked or unlocked',
    'merge-commits': 'an interactive rebase range includes a merge commit',
    'mirror-repo': 'the operation would overwrite a mirror\'s branches (`remotes`)',
    'no-repo': 'the call needs the tab\'s repository and none is open',
    'no-stash': 'the stash entry is gone',
    'no-terminal': 'no terminal program could be started',
    'no-upstream': 'the branch has no upstream (`remotes`)',
    'not-a-repo': 'the folder is not a git repository',
    'not-conflicted': 'the path is not a conflicted file',
    'not-fast-forward': 'a fast-forward was asked for and the branches have diverged',
    'not-found': 'the branch or folder doesn\'t exist',
    'not-merged': 'the branch to delete is not fully merged (force deletes it)',
    'not-merging': 'no merge is in progress',
    'not-rebasing': 'no rebase is in progress',
    nothing: 'there is nothing to do (undo / redo, resolve, restore, an unchanged todo)',
    'nothing-to-commit': 'nothing is staged to commit',
    outside: 'a path leaves the working tree or enters the git dir',
    rebasing: 'a commit at a rebase\'s conflict stop (Continue Rebase commits it)',
    'rebase-exec': 'Continue / Skip of a rebase whose remaining todo runs commands (exec lines): only Abort is offered',
    rejected: 'the remote rejected the push for another reason (`reason`)',
    'rejected-behind': 'the push was rejected: the remote branch has commits we lack',
    'rejected-hook': 'the push was rejected by a remote hook (`remoteMessage`)',
    'rejected-stale': 'the push was rejected: our view of the remote branch is out of date',
    'root-commit': 'an interactive rebase range includes the repository\'s first commit',
    stale: 'what the UI showed changed since (a diff, a path, HEAD)',
    'stash-conflict': 'local changes couldn\'t be re-applied and are kept in the stash (`stash`)',
    submodule: 'a hunk or line action on a submodule',
    symlink: 'a path goes through (or is) a symbolic link',
    timeout: 'git ran past its time limit and was killed',
    'too-large': 'git\'s output exceeded the byte cap and it was killed',
    'too-many': 'an interactive rebase range has more commits than it can edit',
    'untrusted': 'the repository\'s config or hooks run commands and it was not trusted (no prompt: smoke)',
    'unknown-op': 'the operation name is not in the registry',
    'unrelated-histories': 'the histories to merge have no commit in common',
    'unsafe-repo': 'git refuses the repository (dubious ownership)',
    unsupported: 'git can\'t do this here (a type change, a remote without a fetch refspec)',
    'worktree-busy': 'a rebase, merge or similar is stopped in the worktree (`state`), or another tab is running a write there: finish it first',
    'worktree-dirty': 'the worktree has modified or untracked files, or submodules (`submodules`); force deletes it',
    'worktree-locked': 'the worktree is locked (`reason`): unlock it first',
  });

  const KINDS = Object.freeze(Object.fromEntries(Object.keys(MEANING).map((k) => [k.toUpperCase().replace(/-/g, '_'), k])));

  const isKind = (s) => typeof s === 'string' && Object.hasOwn(MEANING, s);

  exports.KINDS = KINDS;
  exports.MEANING = MEANING;
  exports.isKind = isKind;
})(typeof module !== 'undefined' ? module.exports : (window.PLErrorKinds = {})); // NOSONAR(S1121): the CommonJS-or-window export idiom
