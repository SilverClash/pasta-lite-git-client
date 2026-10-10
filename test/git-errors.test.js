'use strict';
// The pure classifiers of git's failure text (src/git-errors.js), with made-up GitErrors: no git runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const { GitError, kindError } = require('../src/exec');
const ge = require('../src/git-errors');

const gitErr = (stderr, stdout = '', code = 1) => new GitError(['x'], code, stderr, stdout);

test('checked-out-elsewhere: one rule for checkout, branch -d and fetch (every spelling git uses)', () => {
  for (const text of [
    "fatal: 'feat' is already used by worktree at '/tmp/wt'",
    "fatal: 'feat' is already checked out at '/tmp/wt'",
    "error: cannot delete branch 'feat' used by worktree at '/tmp/wt'",
    "error: Cannot delete branch 'feat' checked out at '/tmp/wt'",
    "fatal: refusing to fetch into branch 'refs/heads/main' checked out at '/tmp/wt'",
    'fatal: refusing to fetch into current branch refs/heads/main of non-bare repository',
  ]) {
    assert.equal(ge.kindFor(gitErr(text), 'checkedOutElsewhere'), 'checked-out-elsewhere', text);
  }
  assert.equal(ge.kindFor(gitErr("error: pathspec 'x' did not match"), 'checkedOutElsewhere'), null);
});

test('only an unclassified GitError is classified: a kind already set, or another error, is kept', () => {
  const aborted = Object.assign(gitErr('not possible to fast-forward'), { kind: 'aborted' });
  assert.equal(ge.kindFor(aborted, 'notFastForward'), null);
  assert.equal(ge.classify(aborted, ['notFastForward']).kind, 'aborted');
  const plain = Object.assign(new Error('x'), { stderr: 'not possible to fast-forward' });
  assert.equal(ge.kindFor(plain, 'notFastForward'), null);
  assert.equal(ge.unclassified(kindError('stale', 'x')), false);
  const e = gitErr('', 'fatal: Not possible to fast-forward, aborting.');
  assert.equal(ge.classify(e, ['notFastForward']), e);
  assert.equal(e.kind, 'not-fast-forward', 'stdout counts for this rule');
});

test('classify picks the first matching rule, adds extras, and refuses a rule without a kind', () => {
  const e = gitErr('error: The branch is not fully merged.');
  ge.classify(e, ['notFullyMerged', 'checkedOutElsewhere'], { extra: 1 });
  assert.equal(e.kind, 'not-merged');
  assert.equal(e.extra, 1);
  assert.throws(() => ge.kindFor(gitErr('try without --index'), 'applyWithoutIndex'), TypeError);
  assert.throws(() => ge.matches(gitErr(''), 'noSuchRule'), TypeError);
});

test('local changes in the way ("would be overwritten") read the same for checkout and merge', () => {
  for (const text of [
    'error: Your local changes to the following files would be overwritten by checkout:\n\ta.txt\nPlease commit your changes or stash them before you switch branches.',
    'error: Your local changes to the following files would be overwritten by merge:\n\ta.txt',
    'error: The following untracked working tree files would be overwritten by checkout:\n\tb.txt',
  ]) {
    assert.equal(ge.matches(gitErr(text), 'overwritten'), true, text);
  }
  assert.equal(ge.kindFor(gitErr('error: would be overwritten by merge'), 'overwritten'), 'dirty');
  assert.equal(ge.matches(gitErr('CONFLICT (content): Merge conflict in a.txt'), 'overwritten'), false);
});

test('failureKind: signing, a known non-hook reason, or null (maybe a hook)', () => {
  assert.equal(ge.failureKind(gitErr('error: gpg failed to sign the data\nfatal: failed to write commit object')), 'signing');
  assert.equal(ge.failureKind(gitErr('', 'error: Your local changes would be overwritten by merge')), 'other');
  assert.equal(ge.failureKind(gitErr('error: The following untracked working tree files would be removed by merge')), 'other');
  assert.equal(ge.failureKind(gitErr('error: commit-msg hook: subject too long')), null);
  assert.equal(ge.failureKind(gitErr('error: could not execute the todo command\n\n    exec false'.replace('could', 'Could'))), 'other');
  assert.equal(ge.failureKind(gitErr('husky - pre-commit hook exited with code 1')), null);
  assert.equal(ge.failureKind(null), null);
});

test('nothing-to-commit reads stdout only; unmerged, auth and the open-folder rules', () => {
  assert.equal(ge.matches(gitErr('', 'nothing to commit, working tree clean'), 'nothingToCommit'), true);
  assert.equal(ge.matches(gitErr('nothing to commit'), 'nothingToCommit'), false, 'a hook printing it on stderr does not count');
  assert.equal(ge.matches(gitErr('error: Committing is not possible because you have unmerged files.'), 'unmerged'), true);
  assert.equal(ge.kindFor(gitErr('fatal: Authentication failed for https://x'), 'auth'), 'auth');
  assert.equal(ge.kindFor(gitErr("remote: hint: branch 'fatal: Authentication failed' exists"), 'auth'), null, 'anchored to fatal: lines');
  assert.equal(ge.matches(gitErr('fatal: detected dubious ownership in repository'), 'dubiousOwnership'), true);
  assert.equal(ge.matches(gitErr('fatal: not a git repository (or any of the parent directories): .git'), 'notARepo'), true);
  assert.equal(ge.matches(gitErr("fatal: cannot use bare repository '/x' (safe.bareRepository is 'explicit')"), 'bareRefused'), true);
});

test('classifyPush: ref lines first, then auth, then the mirror refusal', () => {
  const push = (stdout, stderr = '') => ge.classifyPush(gitErr(stderr, stdout));
  assert.deepEqual(push('To x\n!\trefs/heads/a:refs/heads/a\t[rejected] (non-fast-forward)\nDone'),
    { kind: 'rejected-behind', extra: { refspec: 'refs/heads/a:refs/heads/a', reason: 'non-fast-forward' } });
  assert.equal(push('!\ta:a\t[rejected] (fetch first)').kind, 'rejected-stale');
  assert.equal(push('!\ta:a\t[rejected] (stale info)').kind, 'rejected-stale');
  assert.equal(push('!\ta:a\t[rejected] (other)').kind, 'rejected');
  assert.deepEqual(push('!\ta:a\t[remote rejected] (pre-receive hook declined)', 'remote: no\nremote: way'),
    { kind: 'rejected-hook', extra: { refspec: 'a:a', reason: 'pre-receive hook declined', remoteMessage: 'no\nway' } });
  assert.equal(push('', 'fatal: could not read Username for x').kind, 'auth');
  assert.equal(push('', "fatal: --mirror can't be combined with refspecs").kind, 'mirror-repo');
  assert.equal(push('', 'fatal: something else'), null);
});

test('rejectedFetchRefs lists the refs of fetch --porcelain "!" lines', () => {
  assert.deepEqual(ge.rejectedFetchRefs('! 1 2 refs/tags/v1\n* 3 4 refs/remotes/o/x\n! 5 6 refs/tags/v 2'), ['refs/tags/v1', 'refs/tags/v 2']);
  assert.deepEqual(ge.rejectedFetchRefs(undefined), []);
});

test('worktree remove / lock / unlock: the four rules match git\'s own messages (git 2.51)', () => {
  const cases = [
    ["fatal: '../w1' contains modified or untracked files, use --force to delete it", 'worktreeDirty', 'worktree-dirty'],
    ['fatal: working trees containing submodules cannot be moved or removed', 'worktreeDirty', 'worktree-dirty'],
    ["fatal: cannot remove a locked working tree, lock reason: on a stick\nuse 'remove -f -f' to override or unlock first", 'worktreeLocked', 'worktree-locked'],
    ["fatal: cannot remove a locked working tree;\nuse 'remove -f -f' to override or unlock first", 'worktreeLocked', 'worktree-locked'],
    ["fatal: '.' is a main working tree", 'mainWorktree', 'main-worktree'],
    ['fatal: The main working tree cannot be locked or unlocked', 'mainWorktree', 'main-worktree'],
    ["fatal: '/tmp/nowhere' is not a working tree", 'notAWorktree', 'not-found'],
  ];
  const names = ['worktreeDirty', 'worktreeLocked', 'mainWorktree', 'notAWorktree'];
  for (const [text, rule, kind] of cases) {
    assert.equal(ge.matches(gitErr(text), rule), true, text);
    assert.equal(ge.kindFor(gitErr(text), ...names), kind, text);
  }
  assert.equal(ge.kindFor(gitErr("fatal: '.' is a main working tree", 'contains modified or untracked files'), ...names), 'main-worktree', 'stdout is not read');
  assert.equal(ge.kindFor(gitErr("fatal: invalid reference: x"), ...names), null);
});

test('clone rules: each matches git\'s own lines (as the progress parser keeps them), in the order clone tries them', () => {
  const { RULE_ORDER } = require('../src/clone')._internal;
  const cases = [
    ["fatal: repository 'http://127.0.0.1:5/x.git/' not found", 'not-found'],
    ["fatal: repository '/tmp/nope' does not exist", 'not-found'],
    ["fatal: '/tmp/nope.git' does not appear to be a git repository\nfatal: Could not read from remote repository.", 'not-found'],
    ['ERROR: Repository not found.\nfatal: Could not read from remote repository.', 'not-found'],
    ['remote: Repository not found.\nfatal: repository \'https://github.com/o/x.git/\' not found', 'not-found'],
    ['Host key verification failed.\nfatal: Could not read from remote repository.', 'host-key'],
    ['No ED25519 host key is known for example.com and you have requested strict checking.\nHost key verification failed.', 'host-key'],
    ["fatal: unable to access 'https://nohost.invalid/r.git/': Could not resolve host: nohost.invalid", 'unreachable'],
    ["fatal: unable to access 'https://127.0.0.1:9/r.git/': Failed to connect to 127.0.0.1 port 9 after 0 ms: Couldn't connect to server", 'unreachable'],
    ["fatal: unable to access 'https://h/r.git/': SSL certificate problem: self-signed certificate", 'unreachable'],
    ["fatal: unable to access 'http://127.0.0.1:5/r.git/': Recv failure: Connection reset by peer", 'unreachable'],
    ["fatal: unable to access 'http://h/r.git/': Empty reply from server", 'unreachable'],
    ["fatal: unable to access 'http://h/r.git/': Send failure: Broken pipe", 'unreachable'],
    ['ssh: Could not resolve hostname nohost: nodename nor servname provided, or not known\nfatal: Could not read from remote repository.', 'unreachable'],
    ['ssh: connect to host h port 22: Connection refused\nfatal: Could not read from remote repository.', 'unreachable'],
    ['ssh: connect to host h port 22: Operation timed out', 'unreachable'],
    ['fatal: unable to look up nohost (port 9418) (nodename nor servname provided, or not known)', 'unreachable'],
    ["fatal: transport 'fd' not allowed", 'unsupported'],
    ["fatal: destination path '/tmp/x' already exists and is not an empty directory.", 'exists'],
    ['error: unable to write file x: No space left on device\nfatal: cannot store pack file', 'no-space'],
    ['fatal: could not read Username for \'http://127.0.0.1:5\': terminal prompts disabled', 'auth'],
    ["fatal: detected dubious ownership in repository at '/mnt/x'", 'unsafe-repo'],
  ];
  for (const [text, kind] of cases) {
    const e = gitErr(text);
    e.message = text; // clone sets the message to these lines too (dubiousOwnership reads it)
    assert.equal(ge.kindFor(e, ...RULE_ORDER), kind, text);
  }
  assert.equal(ge.kindFor(gitErr('fatal: Could not read from remote repository.'), ...RULE_ORDER), null, 'ssh\'s closing line alone decides nothing');
  assert.equal(ge.matches(gitErr('warning: Clone succeeded, but checkout failed.\nYou can inspect what was checked out'), 'checkoutFailed'), true);
  assert.equal(ge.RULES.checkoutFailed.kind, undefined, 'a result, not an error kind');
});

test('clone rules are anchored: ref names, hook output and stdout don\'t match', () => {
  const { RULE_ORDER } = require('../src/clone')._internal;
  for (const text of [
    "remote: hint: branch 'fatal: repository x not found' exists",
    'hook says: Host key verification failed',
    'echo ssh: Could not resolve hostname',
    "note: fatal: transport 'fd' not allowed",
    'x warning: Clone succeeded, but checkout failed',
  ]) {
    assert.equal(ge.kindFor(gitErr(text), ...RULE_ORDER.filter((r) => r !== 'noSpace' && r !== 'destinationExists')), null, text);
  }
  assert.equal(ge.matches(gitErr('x warning: Clone succeeded, but checkout failed'), 'checkoutFailed'), false);
  // stdout is never read by these rules.
  assert.equal(ge.kindFor(gitErr('', 'Host key verification failed.\nfatal: transport \'x\' not allowed\nNo space left on device'), ...RULE_ORDER), null);
});
