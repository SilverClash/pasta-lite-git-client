'use strict';
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { tmpDir, git, initRepo, write, read, commitFile, repoWithRemote, hostileConfig, cleanup } = require('./helpers');
const g = require('../src/git');

after(cleanup);

const head = (dir) => git(dir, 'rev-parse', 'HEAD').trim();
const exists = (dir, f) => fs.existsSync(path.join(dir, f));

test('trimTrailingNewlines: the same as replace(/\\n+$/, ""), in linear time', () => {
  for (const s of ['', '\n', '\n\n', 'a', 'a\n', 'a\n\n\n', '\na\n', 'a\n\nb', 'a\r\n', 'a\n ']) {
    assert.equal(g.trimTrailingNewlines(s), s.replace(/\n+$/, ''), JSON.stringify(s));
  }
  const long = `${'\n'.repeat(200000)}x`; // quadratic for the regex
  assert.equal(g.trimTrailingNewlines(long), long);
});

/** Push a new commit to origin/main from the seed clone. */
function upstreamCommit(seed, file, content, msg) {
  const sha = commitFile(seed, file, content, msg);
  git(seed, 'push', '-q', 'origin', 'main');
  return sha;
}

describe('root', () => {
  test('returns toplevel from a subdir and throws outside a repo', async () => {
    const dir = initRepo();
    write(dir, 'sub/x.txt', 'x');
    assert.equal(await g.root(path.join(dir, 'sub')), dir);
    await assert.rejects(g.root(tmpDir()));
  });

  test('a subdirectory that became its own repo (git init) is its own root', async () => {
    const dir = initRepo();
    write(dir, 'sub/x.txt', 'x');
    const sub = path.join(dir, 'sub');
    assert.equal(await g.root(sub), dir);
    git(sub, 'init', '-q');
    assert.equal(await g.root(sub), sub);
    assert.deepEqual((await g.status(sub)).unstaged, [{ path: 'x.txt', status: '?' }]);
  });
});

describe('riskyLocalConfig', () => {
  test('lists repo config keys that run commands; none for a plain repo', async () => {
    const dir = initRepo();
    assert.deepEqual(await g.riskyLocalConfig(dir), []);
    git(dir, 'config', 'filter.Evil.clean', 'touch pwned');
    git(dir, 'config', 'filter.lfs.process', 'x');
    git(dir, 'config', 'core.sshCommand', 'ssh -o x');
    git(dir, 'config', 'core.hooksPath', '/tmp/hooks');
    git(dir, 'config', 'core.gitProxy', 'proxy');
    git(dir, 'config', 'credential.helper', 'store');
    git(dir, 'config', 'credential.https://example.com.helper', 'x');
    git(dir, 'config', 'gpg.program', 'gpg2');
    git(dir, 'config', 'gpg.ssh.program', 'ssh-keygen');
    git(dir, 'config', 'core.editor', 'vi');
    git(dir, 'config', 'sequence.editor', 'touch pwned');
    git(dir, 'config', 'gpg.ssh.defaultKeyCommand', 'touch pwned');
    git(dir, 'config', 'core.alternateRefsCommand', 'touch pwned');
    git(dir, 'config', 'core.pager', 'touch pwned');
    git(dir, 'config', 'pager.log', 'touch pwned');
    git(dir, 'config', 'diff.external', 'touch pwned');
    git(dir, 'config', 'diff.Bin.textconv', 'touch pwned');
    git(dir, 'config', 'diff.bin.command', 'touch pwned');
    git(dir, 'config', 'mergetool.x.cmd', 'touch pwned');
    git(dir, 'config', 'difftool.x.path', '/tmp/pwned');
    git(dir, 'config', 'trailer.sign.cmd', 'touch pwned');
    git(dir, 'config', 'trailer.sign.command', 'touch pwned');
    // Not commands, or neutralised by exec.js (core.fsmonitor), or not read from repo config
    // (uploadpack.packObjectsHook):
    git(dir, 'config', 'core.fsmonitor', 'true');
    git(dir, 'config', 'filter.Evil.required', 'true');
    git(dir, 'config', 'credential.username', 'me');
    git(dir, 'config', 'user.name', 'x');
    git(dir, 'config', 'uploadpack.packObjectsHook', 'touch pwned');
    git(dir, 'config', 'diff.bin.binary', 'true');
    git(dir, 'config', 'trailer.sign.key', 'Signed');
    git(dir, 'config', 'core.alternateRefsPrefixes', 'refs/heads');
    assert.deepEqual(await g.riskyLocalConfig(path.join(dir)), [
      'core.alternaterefscommand', 'core.editor', 'core.gitproxy', 'core.hookspath', 'core.pager', 'core.sshcommand',
      'credential.helper', 'credential.https://example.com.helper',
      'diff.Bin.textconv', 'diff.bin.command', 'diff.external', 'difftool.x.path',
      'filter.Evil.clean', 'filter.lfs.process',
      'gpg.program', 'gpg.ssh.defaultkeycommand', 'gpg.ssh.program', 'mergetool.x.cmd', 'pager.log', 'sequence.editor',
      'trailer.sign.cmd', 'trailer.sign.command',
    ]);
  });

  test('keys risky only for some values: protocol.*allow = always (any case), submodule.*.update = !command', async () => {
    const dir = initRepo();
    git(dir, 'config', 'protocol.allow', 'user');
    git(dir, 'config', 'protocol.file.allow', 'never');
    git(dir, 'config', 'submodule.a.update', 'rebase');
    assert.deepEqual(await g.riskyLocalConfig(dir), []);
    git(dir, 'config', 'protocol.allow', 'always');
    git(dir, 'config', 'protocol.ext.allow', 'ALWAYS');
    git(dir, 'config', 'submodule.b.update', '!touch pwned');
    assert.deepEqual(await g.riskyLocalConfig(dir), ['protocol.allow', 'protocol.ext.allow', 'submodule.b.update']);
  });

  test('follows includes; ignores global and -c config', async () => {
    const dir = initRepo();
    const inc = path.join(tmpDir(), 'inc.cfg');
    fs.writeFileSync(inc, '[filter "x"]\n\tsmudge = evil\n');
    git(dir, 'config', 'include.path', inc);
    assert.deepEqual(await g.riskyLocalConfig(dir), ['filter.x.smudge', 'include.path']);
    const globalCfg = path.join(tmpDir(), 'global.cfg');
    fs.writeFileSync(globalCfg, '[core]\n\tsshCommand = ssh\n[include]\n\tpath = /nowhere\n');
    const saved = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = globalCfg;
    try {
      assert.deepEqual(await g.riskyLocalConfig(dir), ['filter.x.smudge', 'include.path']);
    } finally {
      process.env.GIT_CONFIG_GLOBAL = saved;
    }
  });

  test('every include is listed by name, whatever it points at now: onbranch: and a path into the working tree apply later', async () => {
    const dir = initRepo();
    const marker = path.join(tmpDir(), 'ran');
    // Relative to .git/config: a file of the working tree, which no branch has yet.
    git(dir, 'config', 'includeIf.onbranch:feature.path', '../feature.cfg');
    git(dir, 'config', 'include.path', '../shared.cfg');
    assert.deepEqual(await g.riskyLocalConfig(dir), ['include.path', 'includeif.onbranch:feature.path']);
    // What it guards against: the included file arrives with a checkout, and applies on that branch.
    git(dir, 'checkout', '-q', '-b', 'feature');
    // '/' separators: in a config file a '\' starts an escape (Windows' C:\Users\...).
    write(dir, 'feature.cfg', `[filter "x"]\n\tclean = touch '${marker.split(path.sep).join('/')}'; cat\n`);
    write(dir, '.gitattributes', '* filter=x\n');
    write(dir, 'README.md', 'changed\n');
    await g.stage(dir, ['README.md']);
    assert.equal(fs.existsSync(marker), true);
  });

  test('a filter driver from repo config runs during normal use (what the check guards against)', async () => {
    const dir = initRepo();
    const marker = path.join(tmpDir(), 'ran');
    write(dir, '.gitattributes', '* filter=x\n');
    git(dir, 'config', 'filter.x.clean', `touch '${marker}'; cat`);
    write(dir, 'README.md', 'changed\n');
    assert.deepEqual(await g.riskyLocalConfig(dir), ['filter.x.clean']);
    await g.stage(dir, ['README.md']);
    assert.equal(fs.existsSync(marker), true);
  });
});

describe('riskyHooks (a working-tree repo)', () => {
  test('a clone has only samples; an unzipped repo\'s executable .git/hooks are listed, and run on commit', async () => {
    const { local } = repoWithRemote();
    assert.ok(fs.readdirSync(path.join(local, '.git', 'hooks')).some((f) => f.endsWith('.sample')), 'a clone has the samples');
    assert.deepEqual(await g.riskyHooks(local), []);
    // What a downloaded folder can carry: its .git/hooks came with it, executable.
    const marker = path.join(tmpDir(), 'ran');
    write(local, '.git/hooks/pre-commit', `#!/bin/sh\ntouch '${marker}'\n`);
    fs.chmodSync(path.join(local, '.git', 'hooks', 'pre-commit'), 0o755);
    write(local, '.git/hooks/post-checkout', '#!/bin/sh\n');
    assert.deepEqual(await g.riskyHooks(local), process.platform === 'win32' ? ['hooks/post-checkout', 'hooks/pre-commit'] : ['hooks/pre-commit']);
    assert.deepEqual(await g.riskyHooks(path.join(local, '.git')), await g.riskyHooks(local), 'from the git dir too');
    // A linked worktree runs the main repo's hooks.
    const wt = path.join(tmpDir(), 'wt');
    git(local, 'worktree', 'add', '-q', '-b', 'side', wt);
    assert.deepEqual(await g.riskyHooks(wt), await g.riskyHooks(local));
    if (process.platform !== 'win32') {
      write(local, 'x.txt', 'x\n');
      await g.stage(local, ['x.txt']);
      await g.commit(local, 'feat: x');
      assert.equal(fs.existsSync(marker), true, 'the hook ran: what the trust check guards against');
    }
  });
});

describe('status', () => {
  test('modified, staged, untracked, deleted', async () => {
    const dir = initRepo();
    commitFile(dir, 'a.txt', 'a\n');
    commitFile(dir, 'gone.txt', 'g\n');
    write(dir, 'a.txt', 'a2\n');
    write(dir, 'new.txt', 'n\n');
    git(dir, 'add', 'new.txt');
    write(dir, 'new.txt', 'n2\n');
    write(dir, 'dir/untracked.txt', 'u\n');
    fs.unlinkSync(path.join(dir, 'gone.txt'));
    const st = await g.status(dir);
    assert.equal(st.branch, 'main');
    assert.equal(st.oid, head(dir));
    assert.equal(st.upstream, null);
    assert.equal(st.state, 'clean');
    assert.deepEqual(st.staged, [{ path: 'new.txt', status: 'A' }]);
    assert.deepEqual(
      st.unstaged.sort((x, y) => x.path.localeCompare(y.path)),
      [
        { path: 'a.txt', status: 'M' },
        { path: 'dir/untracked.txt', status: '?' },
        { path: 'gone.txt', status: 'D' },
        { path: 'new.txt', status: 'M' },
      ],
    );
    assert.deepEqual(st.conflicted, []);
  });

  test('renames and paths with spaces / unicode', async () => {
    const dir = initRepo();
    commitFile(dir, 'old name.txt', 'same content\nmore lines\n');
    git(dir, 'mv', 'old name.txt', 'nëw näme ✓.txt');
    write(dir, 'spaced dir/ünï côde.txt', 'x');
    const st = await g.status(dir);
    assert.deepEqual(st.staged, [{ path: 'nëw näme ✓.txt', status: 'R', orig: 'old name.txt' }]);
    assert.deepEqual(st.unstaged, [{ path: 'spaced dir/ünï côde.txt', status: '?' }]);
  });

  test('empty repo', async () => {
    const dir = initRepo({ commits: false });
    let st = await g.status(dir);
    assert.equal(st.branch, 'main');
    assert.equal(st.oid, null);
    assert.deepEqual(st.staged, []);
    write(dir, 'f.txt', 'f');
    st = await g.status(dir);
    assert.deepEqual(st.unstaged, [{ path: 'f.txt', status: '?' }]);
  });

  test('detached HEAD', async () => {
    const dir = initRepo();
    git(dir, 'checkout', '-q', '--detach');
    const st = await g.status(dir);
    assert.equal(st.branch, null);
    assert.equal(st.oid, head(dir));
  });

  test('upstream ahead/behind', async () => {
    const { local, seed } = repoWithRemote();
    upstreamCommit(seed, 's.txt', 's', 's');
    git(local, 'fetch', '-q');
    commitFile(local, 'l.txt', 'l');
    const st = await g.status(local);
    assert.equal(st.upstream, 'origin/main');
    assert.equal(st.ahead, 1);
    assert.equal(st.behind, 1);
  });

  test('merging state with conflicts', async () => {
    const dir = initRepo();
    commitFile(dir, 'c.txt', 'base\n');
    git(dir, 'checkout', '-q', '-b', 'other');
    commitFile(dir, 'c.txt', 'other\n');
    git(dir, 'checkout', '-q', 'main');
    commitFile(dir, 'c.txt', 'main\n');
    assert.throws(() => git(dir, 'merge', 'other'));
    const st = await g.status(dir);
    assert.equal(st.state, 'merging');
    assert.deepEqual(st.conflicted, [{ path: 'c.txt', status: 'U', xy: 'UU' }]);
    assert.deepEqual(st.staged, []);
  });
});

describe('refs / remotes', () => {
  test('local, remote, tags, ahead/behind, current', async () => {
    const { local, seed } = repoWithRemote();
    upstreamCommit(seed, 's.txt', 's', 's');
    git(local, 'fetch', '-q');
    commitFile(local, 'l1.txt', '1');
    commitFile(local, 'l2.txt', '2');
    git(local, 'branch', 'feature');
    git(local, 'tag', '-a', 'v1', '-m', 'annotated');
    git(local, 'tag', 'light');
    const r = await g.refs(local);
    assert.deepEqual(r.head, { branch: 'main', oid: head(local), detached: false });
    const main = r.local.find((b) => b.name === 'main');
    assert.deepEqual(main, { name: 'main', oid: head(local), upstream: 'origin/main', ahead: 2, behind: 1, gone: false, current: true });
    const feat = r.local.find((b) => b.name === 'feature');
    assert.equal(feat.current, false);
    assert.equal(feat.upstream, null);
    assert.deepEqual(r.remote, [{ name: 'origin/main', remote: 'origin', branch: 'main', oid: head(seed) }]);
    assert.deepEqual(r.tags.find((t) => t.name === 'v1').oid, head(local)); // peeled
    assert.deepEqual(r.tags.find((t) => t.name === 'light').oid, head(local));
    assert.deepEqual(await g.remotes(local), ['origin']);
  });

  test('gone upstream and detached head', async () => {
    const { local } = repoWithRemote();
    git(local, 'checkout', '-q', '-b', 'topic');
    git(local, 'push', '-q', '-u', 'origin', 'topic');
    git(local, 'push', '-q', 'origin', '--delete', 'topic');
    git(local, 'checkout', '-q', '--detach');
    const r = await g.refs(local);
    assert.equal(r.local.find((b) => b.name === 'topic').gone, true);
    assert.equal(r.head.detached, true);
    assert.equal(r.head.branch, null);
  });

  test('empty repo', async () => {
    const r = await g.refs(initRepo({ commits: false }));
    assert.deepEqual(r, { head: { branch: 'main', oid: null, detached: false }, local: [], remote: [], tags: [] });
  });
});

describe('log', () => {
  test('paging with hasMore', async () => {
    const dir = initRepo();
    for (let i = 0; i < 4; i++) commitFile(dir, 'f.txt', `${i}`, `c${i}`);
    let res = await g.log(dir, { limit: 3 });
    assert.equal(res.commits.length, 3);
    assert.equal(res.hasMore, true);
    assert.equal(res.commits[0].subject, 'c3');
    res = await g.log(dir, { limit: 5 });
    assert.equal(res.commits.length, 5);
    assert.equal(res.hasMore, false);
    res = await g.log(dir, { limit: 3, skip: 3 });
    assert.deepEqual(res.commits.map((c) => c.subject), ['c0', 'initial']);
    assert.equal(res.hasMore, false);
  });

  test('fields, body, merge parents and all tips', async () => {
    const dir = initRepo();
    const base = head(dir);
    git(dir, 'checkout', '-q', '-b', 'side');
    const side = commitFile(dir, 's.txt', 's', 'side commit');
    git(dir, 'checkout', '-q', 'main');
    const m = commitFile(dir, 'm.txt', 'm', 'main commit');
    git(dir, 'merge', '-q', '--no-ff', '-m', 'Merge side\n\nbody line 1\nbody line 2', 'side');
    git(dir, 'checkout', '-q', '-b', 'unmerged', base);
    const un = commitFile(dir, 'u.txt', 'u', 'unmerged');
    git(dir, 'checkout', '-q', 'main');
    const { commits } = await g.log(dir);
    assert.equal(commits.length, 5);
    const merge = commits.find((c) => c.subject === 'Merge side');
    assert.deepEqual(merge.parents, [m, side]);
    assert.equal(merge.body, 'body line 1\nbody line 2');
    assert.equal(merge.author, 'Test');
    assert.equal(merge.email, 'test@example.com');
    assert.equal(typeof merge.date, 'number');
    assert.ok(merge.committerDate > 1e9);
    assert.ok(commits.some((c) => c.hash === un));
    assert.deepEqual(commits.find((c) => c.hash === base).parents, []);
  });

  test('empty repo', async () => {
    assert.deepEqual(await g.log(initRepo({ commits: false })), { commits: [], hasMore: false, tips: [], next: null });
  });
});

describe('stashes', () => {
  test('lists newest first', async () => {
    const dir = initRepo();
    assert.deepEqual(await g.stashes(dir), []);
    write(dir, 'README.md', 'one');
    git(dir, 'stash', 'push', '-q', '-m', 'first');
    write(dir, 'README.md', 'two');
    git(dir, 'stash', 'push', '-q', '-m', 'second');
    const list = await g.stashes(dir);
    assert.equal(list.length, 2);
    assert.equal(list[0].ref, 'stash@{0}');
    assert.equal(list[0].index, 0);
    assert.match(list[0].message, /second/);
    assert.match(list[1].message, /first/);
    assert.equal(list[0].hash, git(dir, 'rev-parse', 'stash@{0}').trim());
    assert.equal(list[0].parents[0], head(dir));
    assert.ok(list[0].date > 1e9);
  });
});

describe('commit files and diffs', () => {
  test('commitFiles incl. root commit, rename, delete', async () => {
    const dir = initRepo();
    const rootSha = head(dir);
    assert.deepEqual(await g.commitFiles(dir, rootSha), [{ status: 'A', path: 'README.md' }]);
    commitFile(dir, 'a b.txt', 'line1\nline2\nline3\n');
    git(dir, 'mv', 'a b.txt', 'c ü.txt');
    git(dir, 'rm', '-q', 'README.md');
    git(dir, 'commit', '-q', '-m', 'mv');
    const files = await g.commitFiles(dir, head(dir));
    assert.deepEqual(files.sort((x, y) => (x.path < y.path ? -1 : 1)), [
      { status: 'D', path: 'README.md' },
      { status: 'R', orig: 'a b.txt', path: 'c ü.txt' },
    ]);
  });

  test('diffCommitFile vs parent and root', async () => {
    const dir = initRepo();
    const rootPatch = await g.diffCommitFile(dir, head(dir), 'README.md');
    assert.match(rootPatch, /^diff --git a\/README.md b\/README.md/);
    assert.match(rootPatch, /\+hello/);
    commitFile(dir, 'README.md', 'hello\nworld\n');
    const p = await g.diffCommitFile(dir, head(dir), 'README.md');
    assert.match(p, /^\+world$/m);
    assert.doesNotMatch(p, /^\+hello$/m);
  });

  test('diffCommitFile rename with orig', async () => {
    const dir = initRepo();
    commitFile(dir, 'x.txt', 'a\nb\nc\nd\n');
    git(dir, 'mv', 'x.txt', 'y.txt');
    git(dir, 'commit', '-q', '-m', 'mv');
    const p = await g.diffCommitFile(dir, head(dir), 'y.txt', 'x.txt');
    assert.match(p, /rename from x.txt/);
    assert.match(p, /rename to y.txt/);
  });

  test('diffWorkdir unstaged, staged, untracked', async () => {
    const dir = initRepo();
    write(dir, 'README.md', 'hello\nstaged\n');
    git(dir, 'add', 'README.md');
    write(dir, 'README.md', 'hello\nstaged\nunstaged\n');
    write(dir, 'new file.txt', 'brand new\n');
    const unstaged = await g.diffWorkdir(dir, 'README.md');
    assert.match(unstaged, /^\+unstaged$/m);
    assert.doesNotMatch(unstaged, /^\+staged$/m);
    const staged = await g.diffWorkdir(dir, 'README.md', { staged: true });
    assert.match(staged, /^\+staged$/m);
    assert.doesNotMatch(staged, /^\+unstaged$/m);
    const untracked = await g.diffWorkdir(dir, 'new file.txt', { untracked: true });
    assert.match(untracked, /new file mode/);
    assert.match(untracked, /^\+brand new$/m);
  });

  test('diffWorkdir with orig: rename section over both paths; without it, the exact hunks.js argument lists', async () => {
    const { out, DIFF_OPTS, LITERAL_ENV } = require('../src/exec');
    const dir = initRepo();
    hostileConfig(dir);
    const body = Array.from({ length: 12 }, (_, i) => `r${i}\n`).join('');
    commitFile(dir, 'from.txt', body);
    git(dir, 'mv', 'from.txt', 'to.txt');
    write(dir, 'to.txt', body.replace('r5\n', 'R5\n'));
    git(dir, 'add', 'to.txt');
    const renamed = await g.diffWorkdir(dir, 'to.txt', { staged: true, orig: 'from.txt' });
    assert.match(renamed, /^rename from from\.txt\nrename to to\.txt$/m);
    assert.match(renamed, /^-r5\n\+R5$/m);
    assert.doesNotMatch(renamed, /^new file mode/m);
    const DIFF = { env: LITERAL_ENV, diff: true, encoding: 'latin1' };
    assert.equal(await g.diffWorkdir(dir, 'to.txt', { staged: true }), await out(dir, ['diff', '--cached', ...DIFF_OPTS, '--', 'to.txt'], DIFF));
    assert.equal(await g.diffWorkdir(dir, 'to.txt', { staged: true, orig: 'to.txt' }), await out(dir, ['diff', '--cached', ...DIFF_OPTS, '--', 'to.txt'], DIFF));
    write(dir, 'to.txt', 'x\n');
    assert.equal(await g.diffWorkdir(dir, 'to.txt'), await out(dir, ['diff', ...DIFF_OPTS, '--', 'to.txt'], DIFF));
    write(dir, 'u.txt', 'u\n');
    await assert.rejects(g.diffWorkdir(dir, 'u.txt', { untracked: true, orig: 'from.txt' }), { kind: 'invalid-args' });
  });

  test('staged diff in empty repo', async () => {
    const dir = initRepo({ commits: false });
    write(dir, 'f.txt', 'first\n');
    git(dir, 'add', 'f.txt');
    assert.match(await g.diffWorkdir(dir, 'f.txt', { staged: true }), /^\+first$/m);
  });
});

describe('stage / unstage / discard', () => {
  test('stage and unstage specific paths (with glob chars and spaces)', async () => {
    const dir = initRepo();
    // A name that is also a pathspec glob matching other.txt (Windows forbids '*' in names).
    const glob = process.platform === 'win32' ? '[o]ther.txt' : '*.txt';
    write(dir, 'README.md', 'changed');
    write(dir, 'sp ace.txt', 's');
    write(dir, glob, 'literal glob');
    write(dir, 'other.txt', 'o');
    await g.stage(dir, ['README.md', 'sp ace.txt', glob]);
    let st = await g.status(dir);
    assert.deepEqual(st.staged.map((f) => f.path).sort(), [glob, 'README.md', 'sp ace.txt'].sort());
    assert.deepEqual(st.unstaged, [{ path: 'other.txt', status: '?' }]);
    await g.unstage(dir, ['README.md', glob]);
    st = await g.status(dir);
    assert.deepEqual(st.staged, [{ path: 'sp ace.txt', status: 'A' }]);
    assert.ok(st.unstaged.some((f) => f.path === 'README.md' && f.status === 'M'));
  });

  test('stage a deletion', async () => {
    const dir = initRepo();
    fs.unlinkSync(path.join(dir, 'README.md'));
    await g.stage(dir, ['README.md']);
    assert.deepEqual((await g.status(dir)).staged, [{ path: 'README.md', status: 'D' }]);
  });

  test('stageAll / unstageAll', async () => {
    const dir = initRepo();
    write(dir, 'README.md', 'x');
    write(dir, 'n.txt', 'n');
    await g.stageAll(dir);
    assert.equal((await g.status(dir)).staged.length, 2);
    await g.unstageAll(dir);
    const st = await g.status(dir);
    assert.equal(st.staged.length, 0);
    assert.equal(st.unstaged.length, 2);
  });

  test('empty repo stage/unstage', async () => {
    const dir = initRepo({ commits: false });
    write(dir, 'a.txt', 'a');
    write(dir, 'b.txt', 'b');
    await g.stage(dir, ['a.txt', 'b.txt']);
    assert.equal((await g.status(dir)).staged.length, 2);
    await g.unstage(dir, ['a.txt']);
    let st = await g.status(dir);
    assert.deepEqual(st.staged, [{ path: 'b.txt', status: 'A' }]);
    assert.ok(exists(dir, 'a.txt'));
    await g.unstageAll(dir);
    st = await g.status(dir);
    assert.deepEqual(st.staged, []);
    assert.equal(st.unstaged.length, 2);
  });

  test('discard tracked and untracked', async () => {
    const dir = initRepo();
    commitFile(dir, 'keep.txt', 'orig\n');
    write(dir, 'README.md', 'mod');
    write(dir, 'keep.txt', 'mod');
    write(dir, 'junk file.txt', 'junk');
    write(dir, 'keep-untracked.txt', 'k');
    fs.unlinkSync(path.join(dir, 'keep.txt'));
    await g.discard(dir, [
      { path: 'README.md', status: 'M' },
      { path: 'keep.txt', status: 'D' },
      { path: 'junk file.txt', status: '?' },
    ]);
    assert.equal(read(dir, 'README.md'), 'hello\n');
    assert.equal(read(dir, 'keep.txt'), 'orig\n');
    assert.ok(!exists(dir, 'junk file.txt'));
    assert.ok(exists(dir, 'keep-untracked.txt'));
  });
});

describe('discard trusts only git\'s untracked list', () => {
  test("'?' on a tracked folder deletes none of its untracked files", async () => {
    const dir = initRepo();
    commitFile(dir, 'dir/tracked.txt', 't\n');
    write(dir, 'dir/untracked.txt', 'u');
    write(dir, 'dir/deep/u2.txt', 'u2');
    await assert.rejects(g.discard(dir, [{ path: 'dir', status: '?' }]), { kind: 'stale' });
    assert.ok(exists(dir, 'dir/untracked.txt'));
    assert.ok(exists(dir, 'dir/deep/u2.txt'));
    assert.equal(read(dir, 'dir/tracked.txt'), 't\n');
  });

  test("'?' on a tracked or ignored file throws stale before anything changes", async () => {
    const dir = initRepo();
    write(dir, '.gitignore', '*.log\n');
    write(dir, 'README.md', 'mod');
    write(dir, 'x.log', 'ignored');
    write(dir, 'u.txt', 'u');
    for (const bogus of ['README.md', 'x.log']) {
      await assert.rejects(
        g.discard(dir, [{ path: 'u.txt', status: '?' }, { path: bogus, status: '?' }, { path: 'README.md', status: 'M' }]),
        (e) => e.kind === 'stale' && e.paths.includes(bogus),
      );
      assert.ok(exists(dir, 'u.txt'));
      assert.ok(exists(dir, bogus));
      assert.equal(read(dir, 'README.md'), 'mod');
    }
  });

  test("a '?' file already gone is skipped; an untracked file in a subfolder is deleted", async () => {
    const dir = initRepo();
    write(dir, 'sub/u.txt', 'u');
    write(dir, 'sub/keep.txt', 'k');
    await g.discard(dir, [{ path: 'gone.txt', status: '?' }, { path: 'sub/u.txt', status: '?' }]);
    assert.ok(!exists(dir, 'sub/u.txt'));
    assert.ok(exists(dir, 'sub/keep.txt'));
  });
});

describe('commit', () => {
  test('commit, amend, amend --only, empty message', async () => {
    const dir = initRepo();
    write(dir, 'a.txt', 'a');
    await g.stage(dir, ['a.txt']);
    const sha = await g.commit(dir, 'Add a\n\nwith body');
    assert.equal(sha, head(dir));
    assert.equal((await g.lastCommit(dir)).message, 'Add a\n\nwith body');

    write(dir, 'b.txt', 'b');
    await g.stage(dir, ['b.txt']);
    const amended = await g.commit(dir, 'Add a and b', { amend: true });
    assert.notEqual(amended, sha);
    assert.equal(git(dir, 'rev-list', '--count', 'HEAD').trim(), '2');
    assert.match(git(dir, 'show', '--name-only', '--format=', 'HEAD'), /b\.txt/);

    write(dir, 'c.txt', 'c');
    await g.stage(dir, ['c.txt']);
    await g.commit(dir, 'Reworded', { amend: true, only: true });
    assert.equal((await g.lastCommit(dir)).message, 'Reworded');
    assert.doesNotMatch(git(dir, 'show', '--name-only', '--format=', 'HEAD'), /c\.txt/);
    assert.deepEqual((await g.status(dir)).staged, [{ path: 'c.txt', status: 'A' }]);

    await assert.rejects(g.commit(dir, '  \n '), /empty/);
  });

  test('lastCommit / commitInfo: {sha, message, summary}; null when unborn', async () => {
    const unborn = initRepo({ commits: false });
    assert.equal(await g.lastCommit(unborn), null);
    const dir = initRepo();
    write(dir, 'a.txt', 'a');
    await g.stage(dir, ['a.txt']);
    const sha = await g.commit(dir, 'Subject\n\nBody line\n');
    assert.deepEqual(await g.lastCommit(dir), { sha, message: 'Subject\n\nBody line', summary: 'Subject' });
    assert.equal((await g.commitInfo(dir, head(dir))).summary, 'Subject');
  });

  test('commit error kinds: empty-message, nothing-to-commit, hook-failed (only with a hook), conflict', async () => {
    const dir = initRepo();
    hostileConfig(dir);
    await assert.rejects(g.commit(dir, ' \n'), { kind: 'empty-message' });
    write(dir, 'README.md', 'unstaged\n');
    await assert.rejects(g.commit(dir, 'm'), { kind: 'nothing-to-commit', message: 'Nothing to commit: no changes are staged' });
    await g.stage(dir, ['README.md']);
    const hookPath = path.join(dir, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hookPath, '#!/bin/sh\necho "  refused by hook  "\nexit 1\n', { mode: 0o755 });
    await assert.rejects(g.commit(dir, 'm'), { kind: 'hook-failed', message: 'refused by hook' });
    // not executable: git ignores it, and so does the classification (Windows has no exec bit)
    if (process.platform !== 'win32') {
      fs.chmodSync(hookPath, 0o644);
      assert.equal(await g.commit(dir, 'm'), head(dir));
      assert.equal((await g.status(dir)).staged.length, 0);
    }
  });

  test('first commit in empty repo', async () => {
    const dir = initRepo({ commits: false });
    assert.equal(await g.lastCommit(dir), null);
    write(dir, 'x', 'x');
    await g.stageAll(dir);
    assert.equal(await g.commit(dir, 'first'), head(dir));
  });
});

describe('fetch', () => {
  test('fetches all and prunes, keeps local tags', async () => {
    const { local, seed } = repoWithRemote();
    git(seed, 'push', '-q', 'origin', 'main:topic');
    await g.fetch(local);
    assert.ok(git(local, 'branch', '-r').includes('origin/topic'));
    git(seed, 'push', '-q', 'origin', '--delete', 'topic');
    git(local, 'tag', 'mine');
    await g.fetch(local, { remote: 'origin' });
    assert.ok(!git(local, 'branch', '-r').includes('origin/topic'));
    assert.match(git(local, 'tag'), /mine/);
  });
});

describe('fetch auth', () => {
  test('an HTTP remote that wants credentials -> kind auth for fetch and pull', async () => {
    const http = require('node:http');
    const server = http.createServer((req, res) => {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="pl-test"' });
      res.end('auth required');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const { local } = repoWithRemote();
      git(local, 'remote', 'set-url', 'origin', `http://127.0.0.1:${server.address().port}/repo.git`);
      await assert.rejects(g.fetch(local), (e) => e.kind === 'auth' && /Username|terminal prompts/i.test(e.message));
      await assert.rejects(g.pull(local), (e) => e.kind === 'auth');
    } finally {
      server.close();
    }
  });
});

describe('pull', () => {
  test('fetch mode only fetches', async () => {
    const { local, seed } = repoWithRemote();
    const s = upstreamCommit(seed, 's.txt', 's', 's');
    const before = head(local);
    const res = await g.pull(local, { mode: 'fetch' });
    assert.deepEqual(res, { mode: 'fetch', before, after: before, fastForward: false, tagConflicts: [] });
    assert.equal(git(local, 'rev-parse', 'origin/main').trim(), s);
  });

  test('ff-if-possible fast-forwards', async () => {
    const { local, seed } = repoWithRemote();
    const s = upstreamCommit(seed, 's.txt', 's', 's');
    const res = await g.pull(local);
    assert.equal(res.mode, 'ff-if-possible');
    assert.equal(res.after, s);
    assert.equal(res.fastForward, true);
  });

  test('ff-if-possible merges diverged history', async () => {
    const { local, seed } = repoWithRemote();
    const s = upstreamCommit(seed, 's.txt', 's', 's');
    const l = commitFile(local, 'l.txt', 'l');
    const res = await g.pull(local, { mode: 'ff-if-possible' });
    assert.equal(res.fastForward, false);
    assert.equal(git(local, 'rev-parse', 'HEAD^1').trim(), l);
    assert.equal(git(local, 'rev-parse', 'HEAD^2').trim(), s);
  });

  test('a merging pull names the branch and remote, not the full ref (-m, like git pull)', async () => {
    const { local, seed } = repoWithRemote();
    const s = upstreamCommit(seed, 's.txt', 's', 's');
    const l = commitFile(local, 'l.txt', 'l');
    const res = await g.pull(local, { mode: 'ff-if-possible' });
    assert.equal(res.fastForward, false);
    assert.deepEqual([git(local, 'rev-parse', 'HEAD^1').trim(), git(local, 'rev-parse', 'HEAD^2').trim()], [l, s]);
    assert.equal(git(local, 'log', '-1', '--format=%B').trim(), "Merge branch 'main' of origin");
  });

  test("a local branch named 'origin/main' doesn't change what a pull merges or its message", async () => {
    const { local, seed } = repoWithRemote();
    const base = head(local);
    git(local, 'branch', 'origin/main', base); // refs/heads/origin/main: ambiguous with the upstream's short name
    const s = upstreamCommit(seed, 's.txt', 's', 's');
    const l = commitFile(local, 'l.txt', 'l');
    await g.pull(local, { mode: 'ff-if-possible' });
    assert.deepEqual([git(local, 'rev-parse', 'HEAD^1').trim(), git(local, 'rev-parse', 'HEAD^2').trim()], [l, s]);
    assert.equal(git(local, 'log', '-1', '--format=%B').trim(), "Merge branch 'main' of origin");
    assert.equal(git(local, 'rev-parse', 'refs/heads/origin/main').trim(), base);
  });

  test('a pull from a differently named upstream says "remote-tracking branch"', async () => {
    const { local, seed } = repoWithRemote();
    const s = upstreamCommit(seed, 's.txt', 's', 's');
    git(local, 'checkout', '-q', '-b', 'topic');
    git(local, 'branch', '-q', '--set-upstream-to=origin/main', 'topic');
    commitFile(local, 'l.txt', 'l');
    await g.pull(local, { mode: 'ff-if-possible' });
    assert.equal(git(local, 'rev-parse', 'HEAD^2').trim(), s);
    assert.equal(git(local, 'log', '-1', '--format=%B').trim(), "Merge remote-tracking branch 'origin/main'");
  });

  test('ff-only fast-forwards and fails on divergence', async () => {
    const { local, seed } = repoWithRemote();
    const s = upstreamCommit(seed, 's.txt', 's', 's');
    let res = await g.pull(local, { mode: 'ff-only' });
    assert.equal(res.after, s);
    assert.equal(res.fastForward, true);
    upstreamCommit(seed, 's2.txt', 's2', 's2');
    const l = commitFile(local, 'l.txt', 'l');
    await assert.rejects(g.pull(local, { mode: 'ff-only' }), (e) => e.kind === 'not-fast-forward');
    assert.equal(head(local), l);
    assert.equal((await g.status(local)).state, 'clean');
  });

  test('rebase replays local commits', async () => {
    const { local, seed } = repoWithRemote();
    const s = upstreamCommit(seed, 's.txt', 's', 's');
    commitFile(local, 'l.txt', 'l', 'local work');
    const res = await g.pull(local, { mode: 'rebase' });
    assert.equal(res.fastForward, false);
    assert.equal(git(local, 'rev-parse', 'HEAD^').trim(), s);
    assert.equal(git(local, 'log', '-1', '--format=%s').trim(), 'local work');
  });

  test('merge conflict -> kind conflicts, repo left merging', async () => {
    const { local, seed } = repoWithRemote();
    upstreamCommit(seed, 'README.md', 'theirs\n', 'theirs');
    commitFile(local, 'README.md', 'ours\n', 'ours');
    await assert.rejects(g.pull(local), (e) => e.kind === 'conflicts');
    const st = await g.status(local);
    assert.equal(st.state, 'merging');
    assert.deepEqual(st.conflicted, [{ path: 'README.md', status: 'U', xy: 'UU' }]);
  });

  test('rebase conflict -> kind conflicts, repo left rebasing', async () => {
    const { local, seed } = repoWithRemote();
    upstreamCommit(seed, 'README.md', 'theirs\n', 'theirs');
    commitFile(local, 'README.md', 'ours\n', 'ours');
    await assert.rejects(g.pull(local, { mode: 'rebase' }), (e) => e.kind === 'conflicts' && e.rebase.stop === 'conflict');
    const st = await g.status(local);
    assert.equal(st.state, 'rebasing');
    assert.equal(st.rebase.branch, 'main');
    assert.equal(st.rebase.ontoName, 'origin/main');
  });

  test('conflict with dirty tree keeps the autostash', async () => {
    const { local, seed } = repoWithRemote();
    upstreamCommit(seed, 'README.md', 'theirs\n', 'theirs');
    commitFile(local, 'README.md', 'ours\n', 'ours');
    write(local, 'wip.txt', 'wip');
    await assert.rejects(g.pull(local), (e) => e.kind === 'conflicts' && e.stashKept === true);
    const list = await g.stashes(local);
    assert.equal(list.length, 1);
    assert.match(list[0].message, /pasta-lite autostash/);
  });

  test('dirty tree is autostashed and restored', async () => {
    const { local, seed } = repoWithRemote();
    const s = upstreamCommit(seed, 'README.md', 'hello\nupstream\n', 'up');
    commitFile(local, 'other.txt', 'base\n');
    write(local, 'other.txt', 'dirty\n');
    write(local, 'untracked.txt', 'u');
    write(local, 'staged.txt', 'st');
    git(local, 'add', 'staged.txt');
    const res = await g.pull(local, { mode: 'rebase' });
    assert.equal(git(local, 'rev-parse', 'HEAD^').trim(), s);
    assert.notEqual(res.before, res.after);
    assert.equal(read(local, 'other.txt'), 'dirty\n');
    assert.equal(read(local, 'untracked.txt'), 'u');
    assert.equal(read(local, 'staged.txt'), 'st');
    assert.equal(read(local, 'README.md'), 'hello\nupstream\n');
    assert.deepEqual(await g.stashes(local), []);
  });

  test('detached and no-upstream', async () => {
    const dir = initRepo();
    await assert.rejects(g.pull(dir), (e) => e.kind === 'no-upstream');
    git(dir, 'checkout', '-q', '--detach');
    await assert.rejects(g.pull(dir), (e) => e.kind === 'detached');
  });
});

describe('withAutostash', () => {
  test('clean tree runs fn directly', async () => {
    const dir = initRepo();
    assert.equal(await g.withAutostash(dir, async () => 42), 42);
    assert.deepEqual(await g.stashes(dir), []);
  });

  test('fn throwing on a clean repo re-applies changes', async () => {
    const dir = initRepo();
    write(dir, 'README.md', 'dirty');
    await assert.rejects(
      g.withAutostash(dir, async () => {
        assert.equal(read(dir, 'README.md'), 'hello\n');
        throw new Error('boom');
      }),
      (e) => e.message === 'boom' && !e.stashKept,
    );
    assert.equal(read(dir, 'README.md'), 'dirty');
    assert.deepEqual(await g.stashes(dir), []);
  });

  test('re-apply conflict resets and keeps stash', async () => {
    const dir = initRepo();
    write(dir, 'README.md', 'dirty\n');
    const err = await g.withAutostash(dir, async () => {
      commitFile(dir, 'README.md', 'committed meanwhile\n');
      return 'done';
    }).catch((e) => e);
    assert.equal(err.kind, 'stash-conflict');
    assert.equal(err.stashKept, true);
    assert.equal(err.reason, 'conflict');
    assert.equal(err.result, 'done');
    const st = await g.status(dir);
    assert.deepEqual([st.staged, st.unstaged, st.conflicted], [[], [], []]);
    assert.equal((await g.stashes(dir)).length, 1);
  });
});

describe('push', () => {
  test('push to upstream', async () => {
    const { local, remote } = repoWithRemote();
    const l = commitFile(local, 'l.txt', 'l');
    const res = await g.push(local);
    assert.deepEqual(res, { remote: 'origin', branch: 'main', remoteBranch: 'main', forced: false });
    assert.equal(git(remote, 'rev-parse', 'main').trim(), l);
    assert.equal(git(local, 'rev-parse', 'origin/main').trim(), l);
  });

  test('no upstream -> kind no-upstream with remotes, then setUpstream + push', async () => {
    const { local, remote } = repoWithRemote();
    git(local, 'checkout', '-q', '-b', 'feature');
    const f = commitFile(local, 'f.txt', 'f');
    await assert.rejects(g.push(local), (e) => e.kind === 'no-upstream' && e.remotes[0] === 'origin');
    await g.setUpstream(local, 'feature', 'origin', 'feature-remote');
    assert.equal(git(local, 'rev-parse', '--abbrev-ref', 'feature@{u}').trim(), 'origin/feature-remote');
    const res = await g.push(local);
    assert.equal(res.remoteBranch, 'feature-remote');
    assert.equal(git(remote, 'rev-parse', 'feature-remote').trim(), f);
  });

  test('explicit remote without upstream', async () => {
    const { local, remote } = repoWithRemote();
    git(local, 'checkout', '-q', '-b', 'x');
    const x = commitFile(local, 'x.txt', 'x');
    await g.push(local, { remote: 'origin' });
    assert.equal(git(remote, 'rev-parse', 'x').trim(), x);
  });

  test('rejected-behind, rejected-stale, and force lease', async () => {
    const { local, seed, remote } = repoWithRemote();
    upstreamCommit(seed, 's.txt', 's', 's');
    const l = commitFile(local, 'l.txt', 'l');
    // Remote has commits we have not fetched.
    await assert.rejects(g.push(local), (e) => e.kind === 'rejected-stale');
    git(local, 'fetch', '-q');
    await assert.rejects(g.push(local), (e) => e.kind === 'rejected-behind');
    const res = await g.push(local, { force: 'lease' });
    assert.equal(res.forced, 'lease');
    assert.equal(git(remote, 'rev-parse', 'main').trim(), l);
  });

  test('force lease fails when remote moved since last fetch', async () => {
    const { local, seed } = repoWithRemote();
    upstreamCommit(seed, 's.txt', 's', 's');
    commitFile(local, 'l.txt', 'l');
    await assert.rejects(g.push(local, { force: 'lease' }), (e) => e.kind === 'rejected-stale');
  });

  test('plain force overwrites', async () => {
    const { local, seed, remote } = repoWithRemote();
    upstreamCommit(seed, 's.txt', 's', 's');
    const l = commitFile(local, 'l.txt', 'l');
    await g.push(local, { force: 'force' });
    assert.equal(git(remote, 'rev-parse', 'main').trim(), l);
  });
});

describe('checkout', () => {
  test('local, remote (new + existing), detached', async () => {
    const { local, seed } = repoWithRemote();
    git(seed, 'checkout', '-q', '-b', 'topic');
    const t = commitFile(seed, 't.txt', 't');
    git(seed, 'push', '-q', 'origin', 'topic');
    git(local, 'fetch', '-q');

    let res = await g.checkout(local, 'origin/topic', { kind: 'remote' });
    assert.deepEqual(res, { branch: 'topic', oid: t });
    assert.equal(git(local, 'rev-parse', '--abbrev-ref', 'topic@{u}').trim(), 'origin/topic');

    res = await g.checkout(local, 'main');
    assert.equal(res.branch, 'main');

    res = await g.checkout(local, 'origin/topic', { kind: 'remote' });
    assert.equal(res.branch, 'topic');

    const mainSha = git(local, 'rev-parse', 'main').trim();
    res = await g.checkout(local, mainSha, { kind: 'commit' });
    assert.deepEqual(res, { branch: null, oid: mainSha });
  });

  test('remote checkout reuses a local branch only when it tracks that remote branch', async () => {
    const { local, seed } = repoWithRemote();
    git(seed, 'checkout', '-q', '-b', 'topic');
    commitFile(seed, 't.txt', 't');
    git(seed, 'push', '-q', 'origin', 'topic');
    git(local, 'fetch', '-q');
    git(local, 'branch', '--no-track', 'topic', 'main'); // unrelated local 'topic'
    await assert.rejects(g.checkout(local, 'origin/topic', { kind: 'remote' }), (e) => e.kind === 'local-exists' && /topic/.test(e.message));
    assert.equal((await g.status(local)).branch, 'main');
    git(local, 'branch', '-q', '--set-upstream-to=origin/main', 'topic'); // tracks another branch
    await assert.rejects(g.checkout(local, 'origin/topic', { kind: 'remote' }), { kind: 'local-exists' });
    git(local, 'branch', '-q', '--set-upstream-to=origin/topic', 'topic');
    assert.equal((await g.checkout(local, 'origin/topic', { kind: 'remote' })).branch, 'topic');
  });

  test('remote checkout refuses a derived branch name that is not a valid branch', async () => {
    const { local } = repoWithRemote();
    const sha = git(local, 'rev-parse', 'HEAD').trim();
    git(local, 'update-ref', 'refs/remotes/origin/-x', sha);
    git(local, 'update-ref', 'refs/remotes/origin/HEAD', sha);
    await assert.rejects(g.checkout(local, 'origin/-x', { kind: 'remote' }), { kind: 'invalid-args' });
    assert.equal((await g.status(local)).branch, 'main');
  });

  test('branch named like a file', async () => {
    const dir = initRepo();
    git(dir, 'branch', 'README.md');
    const res = await g.checkout(dir, 'README.md');
    assert.equal(res.branch, 'README.md');
  });

  test('autostashes when local changes would be overwritten', async () => {
    const dir = initRepo();
    commitFile(dir, 'README.md', 'hello\n2\n3\n4\n5\n6\n');
    git(dir, 'checkout', '-q', '-b', 'other');
    commitFile(dir, 'README.md', 'OTHER\n2\n3\n4\n5\n6\n');
    git(dir, 'checkout', '-q', 'main');
    commitFile(dir, 'z.txt', 'z');
    write(dir, 'README.md', 'hello\n2\n3\n4\n5\nlocal tail\n');
    const res = await g.checkout(dir, 'other');
    assert.equal(res.branch, 'other');
    assert.match(read(dir, 'README.md'), /OTHER/);
    assert.match(read(dir, 'README.md'), /local tail/);
    assert.deepEqual(await g.stashes(dir), []);
  });
});

describe('branches', () => {
  test('create, create+checkout, invalid names', async () => {
    const dir = initRepo();
    const first = head(dir);
    commitFile(dir, 'x', 'x');
    const b = await g.createBranch(dir, 'feat/one', { start: first });
    assert.deepEqual(b, { name: 'feat/one', sha: first });
    assert.equal((await g.status(dir)).branch, 'main');
    await g.createBranch(dir, 'two', { checkout: true });
    assert.equal((await g.status(dir)).branch, 'two');
    for (const bad of ['bad..name', '-x', 'a b', '@{-1}', '']) {
      await assert.rejects(g.createBranch(dir, bad), /Invalid branch name/);
    }
  });

  test('create+checkout at another commit autostashes blocking local changes (as checkout does)', async () => {
    const dir = initRepo();
    commitFile(dir, 'README.md', 'hello\n2\n3\n4\n5\n6\n');
    const old = head(dir);
    commitFile(dir, 'README.md', 'NEW\n2\n3\n4\n5\n6\n');
    write(dir, 'README.md', 'NEW\n2\n3\n4\n5\nlocal tail\n');
    const b = await g.createBranch(dir, 'from-old', { start: old, checkout: true });
    assert.deepEqual(b, { name: 'from-old', sha: old });
    assert.equal((await g.status(dir)).branch, 'from-old');
    assert.equal(read(dir, 'README.md'), 'hello\n2\n3\n4\n5\nlocal tail\n', 'the change re-applied on the new branch');
    assert.deepEqual(await g.stashes(dir), [], 'the autostash was dropped');
  });

  test('create+checkout: changes that conflict on the start commit end as stash-conflict, stash kept', async () => {
    const dir = initRepo();
    commitFile(dir, 'README.md', 'one\n');
    const old = head(dir);
    commitFile(dir, 'README.md', 'two\n');
    write(dir, 'README.md', 'three\n');
    const err = await g.createBranch(dir, 'clash', { start: old, checkout: true }).then(() => null, (e) => e);
    assert.ok(err, 'rejected');
    assert.equal(err.kind, 'stash-conflict');
    assert.equal(err.stashKept, true);
    assert.equal((await g.status(dir)).branch, 'clash', 'the branch was created and checked out');
    assert.equal(read(dir, 'README.md'), 'one\n', 'working tree left clean');
    const [kept] = await g.stashes(dir);
    assert.equal(kept.hash, err.stash);
    // Other failures (an existing name) pass through without an autostash.
    await assert.rejects(g.createBranch(dir, 'clash', { checkout: true }), (e) => !e.stashKept);
  });

  test('delete returns info, refuses current, not-merged needs force', async () => {
    const { local } = repoWithRemote();
    git(local, 'branch', '--track', 'tracked', 'origin/main');
    const sha = git(local, 'rev-parse', 'tracked').trim();
    assert.deepEqual(await g.deleteBranch(local, 'tracked'), { name: 'tracked', sha, upstream: 'origin/main' });
    await assert.rejects(g.deleteBranch(local, 'main'), /current branch/);
    git(local, 'checkout', '-q', '-b', 'wip');
    const w = commitFile(local, 'w', 'w');
    git(local, 'checkout', '-q', 'main');
    await assert.rejects(g.deleteBranch(local, 'wip'), (e) => e.kind === 'not-merged');
    assert.deepEqual(await g.deleteBranch(local, 'wip', { force: true }), { name: 'wip', sha: w, upstream: null });
    assert.throws(() => git(local, 'rev-parse', '--verify', '-q', 'refs/heads/wip'));
  });
});

describe('stash ops', () => {
  test('push, apply, pop, drop', async () => {
    const dir = initRepo();
    assert.equal(await g.stashPush(dir, 'nothing'), null);
    write(dir, 'README.md', 'one\n');
    write(dir, 'u.txt', 'u');
    const hash = await g.stashPush(dir, 'first');
    assert.ok(hash);
    assert.equal(read(dir, 'README.md'), 'hello\n');
    assert.ok(!exists(dir, 'u.txt'));
    write(dir, 'b.txt', 'b');
    await g.stashPush(dir);
    let list = await g.stashes(dir);
    assert.equal(list.length, 2);
    assert.equal(list[1].hash, hash);

    await g.stashApply(dir, 1);
    assert.equal(read(dir, 'README.md'), 'one\n');
    assert.equal(read(dir, 'u.txt'), 'u');
    assert.equal((await g.stashes(dir)).length, 2);

    git(dir, 'checkout', '-q', '--', 'README.md');
    fs.unlinkSync(path.join(dir, 'u.txt'));
    await g.stashPop(dir, 0);
    assert.equal(read(dir, 'b.txt'), 'b');
    list = await g.stashes(dir);
    assert.equal(list.length, 1);
    assert.equal(list[0].hash, hash);

    await g.stashDrop(dir, 0);
    assert.deepEqual(await g.stashes(dir), []);
  });

  test('pop with conflict keeps the stash', async () => {
    const dir = initRepo();
    write(dir, 'README.md', 'stashed\n');
    await g.stashPush(dir, 's');
    commitFile(dir, 'README.md', 'committed\n');
    await assert.rejects(g.stashPop(dir, 0), (e) => e.kind === 'conflicts');
    assert.equal((await g.stashes(dir)).length, 1);
  });
});

// ---------------------------------------------------------------- review fixes

const ANSI = /\x1b\[/;
const hunkCount = (patch) => (patch.match(/^@@ /gm) || []).length;
const lines20 = (edit = {}) => Array.from({ length: 20 }, (_, i) => edit[i + 1] || `line ${i + 1}`).join('\n') + '\n';

describe('hostile user config', () => {
  test('read and diff functions return identical output', async () => {
    const dir = initRepo();
    commitFile(dir, 'f.txt', lines20());
    commitFile(dir, 'mv-src.txt', 'a\nb\nc\nd\ne\n');
    git(dir, 'mv', 'mv-src.txt', 'mv dst ü.txt');
    git(dir, 'commit', '-q', '-m', 'mv');
    commitFile(dir, 'f.txt', lines20({ 3: 'three', 11: 'eleven' }), 'two hunks');
    const sha = head(dir);
    write(dir, 'f.txt', lines20({ 3: 'III', 11: 'XI' }));
    git(dir, 'add', 'f.txt');
    write(dir, 'f.txt', lines20({ 3: 'III', 11: 'XI', 20: 'twenty' }));
    write(dir, 'f.txt.bak', lines20());
    write(dir, 'new ü.txt', 'new\n');
    write(dir, 'README.md', 'stash me\n');
    git(dir, 'stash', 'push', '-q', '--', 'README.md');

    const snapshot = async () => ({
      status: await g.status(dir),
      refs: await g.refs(dir),
      log: await g.log(dir),
      stashes: await g.stashes(dir),
      files: await g.commitFiles(dir, sha),
      renameFiles: await g.commitFiles(dir, git(dir, 'rev-parse', 'HEAD~1').trim()),
      commitPatch: await g.diffCommitFile(dir, sha, 'f.txt'),
      renamePatch: await g.diffCommitFile(dir, git(dir, 'rev-parse', 'HEAD~1').trim(), 'mv dst ü.txt', 'mv-src.txt'),
      unstaged: await g.diffWorkdir(dir, 'f.txt'),
      staged: await g.diffWorkdir(dir, 'f.txt', { staged: true }),
      untracked: await g.diffWorkdir(dir, 'new ü.txt', { untracked: true }),
      message: await g.lastCommit(dir),
    });
    const before = await snapshot();
    hostileConfig(dir);
    const hostile = await snapshot();
    assert.deepEqual(hostile, before);
    for (const k of ['commitPatch', 'renamePatch', 'unstaged', 'staged', 'untracked']) {
      assert.doesNotMatch(hostile[k], ANSI, k);
      assert.match(hostile[k], /^diff --git a\//, k);
    }
    // diff.context=5 / interHunkContext=10 would merge these into one hunk.
    assert.equal(hunkCount(hostile.commitPatch), 2);
    assert.equal(hunkCount(hostile.staged), 2);
    assert.equal(hunkCount(hostile.unstaged), 1);
    assert.deepEqual(hostile.renameFiles, [{ status: 'R', orig: 'mv-src.txt', path: 'mv dst ü.txt' }]);
    assert.match(hostile.renamePatch, /rename from mv-src.txt/);
    assert.deepEqual(hostile.status.staged, [{ path: 'f.txt', status: 'M' }]);
  });

  test('commit stores the message minus trailing whitespace; # lines kept', async () => {
    const dir = initRepo();
    hostileConfig(dir);
    write(dir, 'a.txt', 'a');
    await g.stage(dir, ['a.txt']);
    await g.commit(dir, '\nSubject  \n\n\n# not a comment\nbody\t\n\n\n');
    assert.equal(git(dir, 'log', '-1', '--format=%B').replace(/\n$/, ''), 'Subject\n\n# not a comment\nbody\n');
    assert.equal((await g.lastCommit(dir)).message, 'Subject\n\n# not a comment\nbody');
  });

  test('pull modes ignore merge.ff / pull.rebase / rebase.autoStash', async () => {
    const { local, seed } = repoWithRemote();
    hostileConfig(local);
    const s = upstreamCommit(seed, 's.txt', 's', 's');
    let res = await g.pull(local);
    assert.equal(res.fastForward, true);
    assert.equal(head(local), s);
    upstreamCommit(seed, 's2.txt', 's2', 's2');
    const l = commitFile(local, 'l.txt', 'l');
    res = await g.pull(local);
    assert.equal(res.fastForward, false);
    assert.equal(res.after, head(local));
    assert.equal(git(local, 'rev-parse', 'HEAD^1').trim(), l); // a merge, not a rebase
    upstreamCommit(seed, 'README.md', 'theirs\n', 'theirs');
    commitFile(local, 'README.md', 'ours\n', 'ours');
    write(local, 'wip.txt', 'wip');
    await assert.rejects(g.pull(local, { mode: 'rebase' }), (e) => e.kind === 'conflicts' && e.stashKept === true);
    assert.equal((await g.status(local)).state, 'rebasing');
    assert.equal((await g.stashes(local)).length, 1); // our autostash, not rebase's
  });
});

describe('diff encoding', () => {
  test('non-UTF-8 content comes back latin1-encoded, byte for byte', async () => {
    const dir = initRepo();
    fs.writeFileSync(path.join(dir, 'l1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    const untracked = await g.diffWorkdir(dir, 'l1.txt', { untracked: true });
    assert.ok(Buffer.from(untracked, 'latin1').includes(Buffer.from([0x66, 0xe9, 0x0a])));
    git(dir, 'add', 'l1.txt');
    assert.ok(Buffer.from(await g.diffWorkdir(dir, 'l1.txt', { staged: true }), 'latin1').includes(0xe9));
    git(dir, 'commit', '-q', '-m', 'latin1');
    assert.ok(Buffer.from(await g.diffCommitFile(dir, head(dir), 'l1.txt'), 'latin1').includes(0xe9));
    fs.writeFileSync(path.join(dir, 'l1.txt'), Buffer.from([0xe8, 0x0a]));
    assert.ok(Buffer.from(await g.diffWorkdir(dir, 'l1.txt'), 'latin1').includes(0xe8));
  });
});

describe('stash index restore', () => {
  const splitRepo = () => {
    const dir = initRepo();
    commitFile(dir, 'f.txt', lines20());
    write(dir, 'f.txt', lines20({ 2: 'staged' }));
    git(dir, 'add', 'f.txt');
    write(dir, 'f.txt', lines20({ 2: 'staged', 15: 'unstaged' }));
    write(dir, 'u.txt', 'untracked\n');
    return { dir, cached: git(dir, 'diff', '--cached'), unstaged: git(dir, 'diff') };
  };

  test('stashPop keeps the staged/unstaged split', async () => {
    const { dir, cached, unstaged } = splitRepo();
    const hash = await g.stashPush(dir, 'split');
    const res = await g.stashPop(dir, 0);
    assert.deepEqual(res, { hash, indexRestored: true, dropped: true });
    assert.equal(git(dir, 'diff', '--cached'), cached);
    assert.equal(git(dir, 'diff'), unstaged);
    assert.equal(read(dir, 'u.txt'), 'untracked\n');
  });

  test('withAutostash keeps the staged/unstaged split', async () => {
    const { dir, cached, unstaged } = splitRepo();
    const seen = [];
    const r = await g.withAutostash(dir, async () => {
      assert.equal(git(dir, 'status', '--porcelain'), '');
      commitFile(dir, 'other.txt', 'o');
      return 7;
    }, { onReapply: (x) => seen.push(x) });
    assert.equal(r, 7);
    assert.deepEqual(seen, [{ indexRestored: true }]);
    assert.equal(git(dir, 'diff', '--cached'), cached);
    assert.equal(git(dir, 'diff'), unstaged);
    assert.deepEqual(await g.stashes(dir), []);
  });

  test('falls back to a plain apply when the index cannot be restored', async () => {
    const dir = initRepo();
    commitFile(dir, 'f.txt', lines20());
    write(dir, 'f.txt', lines20({ 2: 'staged' }));
    git(dir, 'add', 'f.txt');
    write(dir, 'f.txt', lines20({ 15: 'unstaged' })); // line 2 back to HEAD's in the worktree
    await g.stashPush(dir, 'split');
    commitFile(dir, 'f.txt', lines20({ 2: 'committed' }), 'conflicts with the staged change only');
    const res = await g.stashApply(dir, 0);
    assert.equal(res.indexRestored, false);
    assert.equal(read(dir, 'f.txt'), lines20({ 2: 'committed', 15: 'unstaged' }));
    assert.equal(git(dir, 'diff', '--cached'), '');
    assert.equal((await g.stashes(dir)).length, 1);
  });
});

describe('withAutostash failure signals', () => {
  test('apply and reset both failing still reports stashKept + stash', async () => {
    const dir = initRepo();
    write(dir, 'README.md', 'dirty\n');
    const lock = path.join(dir, '.git', 'index.lock');
    const err = await g.withAutostash(dir, async () => {
      fs.writeFileSync(lock, ''); // makes both `stash apply` and `reset --hard` fail
      return 'done';
    }).catch((e) => e);
    fs.unlinkSync(lock);
    assert.equal(err.kind, 'stash-conflict');
    assert.equal(err.stashKept, true);
    assert.equal(err.resetFailed, true);
    assert.equal(err.result, 'done');
    const list = await g.stashes(dir);
    assert.equal(list.length, 1);
    assert.equal(err.stash, list[0].hash);
  });

  test('fn failure plus failed re-apply keeps stash info on the original error', async () => {
    const dir = initRepo();
    write(dir, 'README.md', 'dirty\n');
    const lock = path.join(dir, '.git', 'index.lock');
    const err = await g.withAutostash(dir, async () => {
      fs.writeFileSync(lock, '');
      throw new Error('boom');
    }).catch((e) => e);
    fs.unlinkSync(lock);
    assert.equal(err.message, 'boom');
    assert.equal(err.stashKept, true);
    assert.equal(err.stash, (await g.stashes(dir))[0].hash);
    assert.equal(err.reapplyError.kind, 'stash-conflict');
  });
});

describe('stash entries by hash', () => {
  test('pop by index uses that entry; drop by hash survives index shifts', async () => {
    const dir = initRepo();
    write(dir, 'a.txt', 'A');
    const a = await g.stashPush(dir, 'A');
    write(dir, 'b.txt', 'B');
    const b = await g.stashPush(dir, 'B');
    const res = await g.stashPop(dir, 1);
    assert.equal(res.hash, a);
    assert.equal(read(dir, 'a.txt'), 'A');
    assert.deepEqual((await g.stashes(dir)).map((s) => s.hash), [b]);

    fs.unlinkSync(path.join(dir, 'a.txt'));
    write(dir, 'c.txt', 'C');
    const c = await g.stashPush(dir, 'C'); // b moves from stash@{0} to stash@{1}
    await g.stashDrop(dir, b);
    assert.deepEqual((await g.stashes(dir)).map((s) => s.hash), [c]);
    await assert.rejects(g.stashDrop(dir, b), { kind: 'no-stash' });
    await g.stashApply(dir, c);
    assert.equal(read(dir, 'c.txt'), 'C');
    await assert.rejects(g.stashApply(dir, 5), (e) => e.kind === 'no-stash');
  });
});

describe('push classification', () => {
  test('branch named fix-403 rejected as behind, not auth', async () => {
    const { local, seed } = repoWithRemote();
    git(local, 'checkout', '-q', '-b', 'fix-403');
    git(local, 'push', '-q', '-u', 'origin', 'fix-403');
    git(seed, 'fetch', '-q', 'origin');
    git(seed, 'checkout', '-q', '-b', 'fix-403', 'origin/fix-403');
    commitFile(seed, 's.txt', 's');
    git(seed, 'push', '-q', 'origin', 'fix-403');
    git(local, 'fetch', '-q');
    commitFile(local, 'l.txt', 'l');
    await assert.rejects(g.push(local), (e) => e.kind === 'rejected-behind' && e.reason === 'non-fast-forward');
  });

  test('pre-receive hook rejection -> rejected-hook with the remote message', async () => {
    const { local, remote } = repoWithRemote();
    const hook = path.join(remote, 'hooks', 'pre-receive');
    fs.writeFileSync(hook, '#!/bin/sh\necho "permission denied: protected branch (403)"\nexit 1\n');
    fs.chmodSync(hook, 0o755);
    commitFile(local, 'l.txt', 'l');
    await assert.rejects(g.push(local), (e) => e.kind === 'rejected-hook' && /permission denied/.test(e.remoteMessage));
  });

  test('remote ops honour an AbortSignal', async () => {
    const { local } = repoWithRemote();
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(g.fetch(local, { signal: ac.signal }), (e) => e.kind === 'aborted');
    await assert.rejects(g.push(local, { signal: ac.signal }), (e) => e.kind === 'aborted');
    assert.equal(g.REMOTE_TIMEOUT_MS, 120000);
  });
});

describe('log paging', () => {
  test('stable across a new commit between pages', async () => {
    const dir = initRepo();
    for (let i = 0; i < 6; i++) commitFile(dir, 'f.txt', `${i}`, `c${i}`);
    const all = (await g.log(dir)).commits.map((c) => c.hash);
    const p1 = await g.log(dir, { limit: 3 });
    assert.equal(p1.hasMore, true);
    assert.deepEqual(p1.next, { tips: p1.tips, skip: 3 });
    commitFile(dir, 'f.txt', 'new', 'arrived between pages');
    const p2 = await g.log(dir, { limit: 3, ...p1.next });
    const p3 = await g.log(dir, { limit: 3, ...p2.next });
    assert.equal(p3.hasMore, false);
    assert.equal(p3.next, null);
    assert.deepEqual([...p1.commits, ...p2.commits, ...p3.commits].map((c) => c.hash), all);
    await assert.rejects(g.log(dir, { tips: ['--all'] }), /tips/);
  });
});

describe('fetch tags', () => {
  test('clobbered local tag is kept and reported; branches still update', async () => {
    const { local, seed } = repoWithRemote();
    git(seed, 'tag', 'v1');
    git(seed, 'push', '-q', 'origin', 'v1');
    git(local, 'fetch', '-q', '--tags');
    const oldV1 = git(local, 'rev-parse', 'v1').trim();
    const s = upstreamCommit(seed, 's.txt', 's', 's');
    git(seed, 'tag', '-f', 'v1');
    git(seed, 'tag', 'v2');
    git(seed, 'push', '-q', '-f', 'origin', 'v1', 'v2', 'main:topic');
    const res = await g.fetch(local);
    assert.deepEqual(res, { tagConflicts: ['v1'] });
    assert.equal(git(local, 'rev-parse', 'v1').trim(), oldV1);
    assert.equal(git(local, 'rev-parse', 'v2').trim(), s);
    assert.equal(git(local, 'rev-parse', 'origin/main').trim(), s);
    assert.equal(git(local, 'rev-parse', 'origin/topic').trim(), s);
    const pulled = await g.pull(local);
    assert.deepEqual(pulled.tagConflicts, ['v1']);
    assert.equal(pulled.after, s);
  });
});

describe('exact ref lookups (for-each-ref prefix matching)', () => {
  test("push / pull of branch 'feat' never use the upstream of 'feat/a'", async () => {
    const { local } = repoWithRemote();
    git(local, 'checkout', '-q', '-b', 'feat/a');
    git(local, 'branch', '-q', '--set-upstream-to=origin/main');
    git(local, 'checkout', '-q', 'main');
    git(local, 'branch', '-q', '--unset-upstream');
    git(local, 'checkout', '-q', '--detach');
    await assert.rejects(g.push(local, { branch: 'feat' }), { kind: 'no-upstream' });
  });

  test("deleteBranch of a missing 'feat' when 'feat/a' exists", async () => {
    const dir = initRepo();
    git(dir, 'branch', 'feat/a');
    await assert.rejects(g.deleteBranch(dir, 'feat'), { message: "Branch 'feat' not found" }); // before git runs
    assert.equal(git(dir, 'branch', '--list', 'feat/a').trim(), 'feat/a');
  });
});

describe('fetch without configured refspecs', () => {
  test('a clobbered tag still leaves branches fetched when remote.<r>.fetch is unset', async () => {
    const { local, seed } = repoWithRemote();
    git(seed, 'tag', 'v1');
    git(seed, 'push', '-q', 'origin', 'v1');
    git(local, 'fetch', '-q', '--tags');
    git(local, 'config', '--unset-all', 'remote.origin.fetch');
    const s = upstreamCommit(seed, 's.txt', 's', 's');
    git(seed, 'tag', '-f', 'v1');
    git(seed, 'push', '-q', '-f', 'origin', 'v1');
    const res = await g.fetch(local);
    assert.deepEqual(res, { tagConflicts: ['v1'] });
    assert.equal(git(local, 'rev-parse', 'origin/main').trim(), s);
  });
});

describe('checkout / upstream edge cases', () => {
  test('local checkout of a name with no local branch refuses (no DWIM)', async () => {
    const { local, seed } = repoWithRemote();
    git(seed, 'push', '-q', 'origin', 'main:topic');
    git(local, 'fetch', '-q');
    await assert.rejects(g.checkout(local, 'topic'));
    assert.throws(() => git(local, 'rev-parse', '--verify', '-q', 'refs/heads/topic'));
    assert.equal((await g.status(local)).branch, 'main');
  });

  test('setUpstream when a local branch named origin/x exists', async () => {
    const { local } = repoWithRemote();
    git(local, 'branch', 'origin/x');
    git(local, 'checkout', '-q', '-b', 'feature');
    await g.setUpstream(local, 'feature', 'origin', 'x');
    assert.equal(git(local, 'rev-parse', '--symbolic-full-name', 'feature@{u}').trim(), 'refs/remotes/origin/x');
    assert.equal(git(local, 'config', 'branch.feature.merge').trim(), 'refs/heads/x');
  });
});

describe('paths', () => {
  const ODD = ['new\nline.txt', 'tab\there.txt', 'quote"s.txt', "it's.txt", '-leading-dash.txt', '--', 'back\\slash.txt'];

  test('status and commitFiles with newline, tab, quotes and leading-dash paths', { skip: process.platform === 'win32' && 'Windows forbids newlines, tabs, \'"\' and \'\\\' in file names' }, async () => {
    const dir = initRepo();
    hostileConfig(dir);
    for (const f of ODD) write(dir, f, f);
    const st = await g.status(dir);
    assert.deepEqual(st.unstaged.map((f) => f.path).sort(), [...ODD].sort());
    assert.ok(st.unstaged.every((f) => f.status === '?'));
    await g.stage(dir, ODD);
    assert.deepEqual((await g.status(dir)).staged.map((f) => f.path).sort(), [...ODD].sort());
    const sha = await g.commit(dir, 'odd');
    assert.deepEqual((await g.commitFiles(dir, sha)).map((f) => f.path).sort(), [...ODD].sort());
    // A rename to an odd name, and discard of odd untracked files.
    git(dir, 'mv', '--', '-leading-dash.txt', 'renamed\n-x.txt');
    assert.deepEqual((await g.status(dir)).staged, [{ path: 'renamed\n-x.txt', status: 'R', orig: '-leading-dash.txt' }]);
    const sha2 = await g.commit(dir, 'mv');
    assert.deepEqual(await g.commitFiles(dir, sha2), [{ status: 'R', orig: '-leading-dash.txt', path: 'renamed\n-x.txt' }]);
    for (const f of ['u\nx.txt', '-u.txt']) write(dir, f, 'u');
    await g.discard(dir, [{ path: 'u\nx.txt', status: '?' }, { path: '-u.txt', status: '?' }, { path: 'tab\there.txt', status: 'M' }]);
    assert.ok(!exists(dir, 'u\nx.txt') && !exists(dir, '-u.txt'));
    assert.deepEqual((await g.status(dir)).unstaged, []);
  });

  test('discarding 3000 untracked files', async () => {
    const dir = initRepo();
    const files = Array.from({ length: 3000 }, (_, i) => `many/dir with space/untracked-file-${String(i).padStart(5, '0')}-ü.txt`);
    for (const f of files) write(dir, f, 'x');
    write(dir, 'keep.txt', 'k');
    const st = await g.status(dir);
    assert.equal(st.unstaged.length, 3001);
    await g.discard(dir, st.unstaged.filter((f) => f.path !== 'keep.txt'));
    assert.deepEqual((await g.status(dir)).unstaged, [{ path: 'keep.txt', status: '?' }]);
  });

  test('subdirectory cwd for status / stage / diff / discard', async () => {
    const dir = initRepo();
    commitFile(dir, 'sub/t.txt', 't\n');
    const sub = path.join(dir, 'sub');
    write(dir, 'sub/t.txt', 't2\n');
    write(dir, 'top.txt', 'top\n');
    write(dir, 'sub/u.txt', 'u\n');
    const st = await g.status(sub);
    assert.deepEqual(st.unstaged.map((f) => f.path).sort(), ['sub/t.txt', 'sub/u.txt', 'top.txt']);
    await g.stage(sub, ['top.txt']);
    assert.deepEqual((await g.status(sub)).staged, [{ path: 'top.txt', status: 'A' }]);
    assert.match(await g.diffWorkdir(sub, 'sub/t.txt'), /^\+t2$/m);
    assert.match(await g.diffWorkdir(sub, 'sub/u.txt', { untracked: true }), /^\+u$/m);
    await g.discard(sub, [{ path: 'sub/t.txt', status: 'M' }, { path: 'sub/u.txt', status: '?' }]);
    assert.equal(read(dir, 'sub/t.txt'), 't\n');
    assert.ok(!exists(dir, 'sub/u.txt'));
    assert.equal(await g.root(sub), dir);
  });
});

describe('review fixes: validation helpers', () => {
  test('validateBranchName follows check-ref-format --branch and throws invalid-args', async () => {
    const dir = initRepo();
    for (const ok of ['main', 'feat/x', 'a+b', 'ü-branch']) assert.equal(await g.validateBranchName(dir, ok), ok);
    for (const bad of ['*', 'a:b', 'x^', 'x~1', 'a?', 'a[b', 'a\\b', 'a b', 'a..b', '@{-1}', 'HEAD', '-x', '', 'a\nb', 42]) {
      await assert.rejects(g.validateBranchName(dir, bad), { kind: 'invalid-args' }, String(bad));
    }
    assert.ok(g.REFSPEC_SAFE.test('feat/x'));
    assert.ok(g.REFSPEC_SAFE.test('a+b'));
    for (const bad of ['+x', 'a:b', '*', '-x']) assert.ok(!g.REFSPEC_SAFE.test(bad), bad);
  });

  test('refExists is exact; resolveCommit peels to a commit and never takes options', async () => {
    const dir = initRepo();
    const sha = head(dir);
    git(dir, 'tag', '-a', '-m', 'v', 'v1');
    assert.equal(await g.refExists(dir, 'refs/heads/main'), true);
    for (const r of ['main', 'refs/heads/main@{0}', 'refs/heads/nope', 'refs/heads/../heads/main']) assert.equal(await g.refExists(dir, r), false, r);
    assert.equal(await g.resolveCommit(dir, 'v1'), sha);
    assert.equal(await g.resolveCommit(dir, 'HEAD'), sha);
    assert.equal(await g.resolveCommit(dir, `${sha}^{tree}`), null);
    assert.equal(await g.resolveCommit(dir, '--all'), null);
    assert.equal(await g.resolveCommit(dir, 'nope'), null);
    assert.ok(g.OID.test(sha));
  });

  test('pull rejects prototype-key modes before touching anything', async () => {
    const { local } = repoWithRemote();
    write(local, 'README.md', 'wip\n');
    for (const mode of ['constructor', 'toString', '__proto__']) {
      await assert.rejects(g.pull(local, { mode }), /Unknown pull mode/);
    }
    assert.equal(git(local, 'stash', 'list').trim(), '');
    assert.deepEqual([...g.PULL_MODES].sort(), ['fetch', 'ff-if-possible', 'ff-only', 'rebase']);
  });

  test('setUpstream removes the tracking ref it created when setting the upstream fails', async () => {
    const dir = initRepo();
    await assert.rejects(g.setUpstream(dir, 'main', 'nope', 'main'));
    assert.equal(git(dir, 'for-each-ref', 'refs/remotes').trim(), '');
    await assert.rejects(g.setUpstream(dir, 'main', '-x', 'main'), /Invalid remote/);
  });

  test('diffWorkdir untracked only reads paths git lists as untracked (no symlinked folders)', async () => {
    const dir = initRepo();
    const outside = tmpDir();
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret\n');
    fs.symlinkSync(outside, path.join(dir, 'lnk'));
    fs.symlinkSync('.git', path.join(dir, 'g'));
    write(dir, 'n.txt', 'n\n');
    for (const f of ['lnk/secret.txt', 'g/config', 'README.md', 'nope']) {
      await assert.rejects(g.diffWorkdir(dir, f, { untracked: true }), { kind: 'invalid-args' }, f);
    }
    assert.match(await g.diffWorkdir(dir, 'n.txt', { untracked: true }), /\+n/);
    assert.equal(await g.isUntracked(dir, 'n.txt'), true);
    assert.equal(await g.isUntracked(dir, 'lnk/secret.txt'), false);
  });
});

describe('linked worktrees: list, remove, prune, lock / unlock, the dirty check', () => {
  /** A repo with linked worktrees `names` next to it (one branch each); returns {dir, wts: {name: path}}. */
  function withWorktrees(...names) {
    const dir = initRepo();
    const parent = tmpDir();
    const wts = {};
    for (const n of names) {
      wts[n] = path.join(parent, n);
      git(dir, 'worktree', 'add', '-q', '-b', n, wts[n]);
    }
    return { dir, wts };
  }
  const byPath = (list) => Object.fromEntries(list.map((w) => [w.path, w]));
  // git lists the linked worktrees in its admin folder's directory order: sort them by path.
  const sorted = (list) => [list[0], ...list.slice(1).sort((a, b) => (a.path < b.path ? -1 : 1))];
  const byName = (list) => [...list].sort((a, b) => (a.path < b.path ? -1 : 1));

  test('worktrees: main and current flags from the main worktree and from a linked one, plus the reasons', async () => {
    const { dir, wts } = withWorktrees('a', 'gone');
    git(dir, 'worktree', 'lock', '--reason', 'on a stick', wts.a);
    fs.rmSync(wts.gone, { recursive: true, force: true });
    const list = sorted(await g.worktrees(dir));
    assert.deepEqual(list.map((w) => [w.path, w.main, w.current]), [[dir, true, true], [wts.a, false, false], [wts.gone, false, false]]);
    const by = byPath(list);
    assert.deepEqual(by[wts.a], {
      path: wts.a, head: head(dir), branch: 'a', bare: false, detached: false,
      locked: true, lockReason: 'on a stick', prunable: false, prunableReason: null, main: false, current: false, missing: false,
    });
    assert.equal(by[wts.gone].prunable, true);
    assert.equal(by[wts.gone].missing, true);
    assert.equal(by[dir].missing, false);
    assert.match(by[wts.gone].prunableReason, /non-existent location/);
    // From the linked worktree (and from a folder inside it): that one is current.
    fs.mkdirSync(path.join(wts.a, 'sub'));
    for (const cwd of [wts.a, path.join(wts.a, 'sub')]) {
      const from = sorted(await g.worktrees(cwd));
      assert.deepEqual(from.map((w) => [w.main, w.current]), [[true, false], [false, true], [false, false]], cwd);
    }
  });

  test('worktrees: current is compared through realpath (a symlinked spelling of the repo)', async () => {
    const { dir, wts } = withWorktrees('a');
    const link = path.join(tmpDir(), 'link');
    fs.symlinkSync(dir, link);
    const linkA = path.join(tmpDir(), 'link-a');
    fs.symlinkSync(wts.a, linkA);
    assert.deepEqual((await g.worktrees(link)).map((w) => [w.path, w.current]), [[dir, true], [wts.a, false]]);
    assert.deepEqual((await g.worktrees(linkA)).map((w) => [w.path, w.current]), [[dir, false], [wts.a, true]]);
    assert.equal(g.realPath, undefined, 'not on the git facade: src/fs-paths.js');
  });

  test('worktrees: a locked worktree whose folder is gone is missing, though git doesn\'t call it prunable', async () => {
    const { dir, wts } = withWorktrees('usb', 'here');
    git(dir, 'worktree', 'lock', '--reason', 'on a stick', wts.usb);
    fs.rmSync(wts.usb, { recursive: true, force: true });
    const by = byPath(await g.worktrees(dir));
    assert.deepEqual([by[wts.usb].locked, by[wts.usb].prunable, by[wts.usb].missing], [true, false, true]);
    assert.equal(by[wts.here].missing, false);
    // The dirty check skips it (no git process in a folder that isn't there).
    assert.deepEqual(await g.worktreesDirty(dir), [{ path: wts.here, dirty: false }]);
  });

  test('unreachableCount: the commits a detached HEAD reaches that no branch, tag or remote ref does', async () => {
    const { dir, wts } = withWorktrees('a');
    git(wts.a, 'checkout', '-q', '--detach');
    const at = (cwd) => git(cwd, 'rev-parse', 'HEAD').trim();
    assert.equal(await g.unreachableCount(dir, at(wts.a)), 0, 'on branch a\'s tip');
    commitFile(wts.a, 'x.txt', '1\n', 'one');
    commitFile(wts.a, 'y.txt', '2\n', 'two');
    assert.equal(await g.unreachableCount(dir, at(wts.a)), 2);
    git(dir, 'tag', 'keep', `${at(wts.a)}~1`);
    assert.equal(await g.unreachableCount(dir, at(wts.a)), 1, 'a tag keeps the older one');
    git(dir, 'update-ref', 'refs/remotes/origin/x', at(wts.a));
    assert.equal(await g.unreachableCount(dir, at(wts.a)), 0, 'a remote-tracking ref keeps both');
    await assert.rejects(g.unreachableCount(dir, '--all'), { kind: 'invalid-args' });
  });

  test('removeWorktree: a clean one goes; modified or untracked files are worktree-dirty until forced', async () => {
    const { dir, wts } = withWorktrees('clean', 'mod', 'untr');
    assert.deepEqual(await g.removeWorktree(dir, wts.clean), { path: wts.clean });
    assert.equal(fs.existsSync(wts.clean), false);
    write(wts.mod, 'README.md', 'changed\n');
    write(wts.untr, 'new.txt', 'n\n');
    for (const p of [wts.mod, wts.untr]) {
      await assert.rejects(g.removeWorktree(dir, p), (e) => {
        assert.equal(e.kind, 'worktree-dirty', p);
        assert.equal(e.submodules, undefined);
        return true;
      });
      assert.equal(fs.existsSync(p), true);
    }
    await g.removeWorktree(dir, wts.mod, { force: true });
    assert.equal(fs.existsSync(wts.mod), false);
    assert.deepEqual((await g.worktrees(dir)).map((w) => w.path), [dir, wts.untr]);
    assert.equal(git(dir, 'branch', '--list', 'mod').trim(), 'mod', 'the branch is kept');
  });

  test('removeWorktree: a locked one is worktree-locked even with force; the main one and an unknown path are refused', async () => {
    const { dir, wts } = withWorktrees('l');
    git(dir, 'worktree', 'lock', '--reason', 'keep', wts.l);
    for (const o of [{}, { force: true }]) {
      await assert.rejects(g.removeWorktree(dir, wts.l, o), { kind: 'worktree-locked' });
    }
    assert.equal(fs.existsSync(wts.l), true);
    await assert.rejects(g.removeWorktree(dir, dir), { kind: 'main-worktree' });
    await assert.rejects(g.removeWorktree(dir, path.join(tmpDir(), 'nowhere')), { kind: 'not-found' });
    // `--` is passed: a path starting with '-' is a path, not an option.
    await assert.rejects(g.removeWorktree(dir, '--force'), { kind: 'not-found' });
  });

  test('pruneWorktrees: the dry run lists without removing; prune removes; a locked prunable entry is kept', async () => {
    const { dir, wts } = withWorktrees('gone', 'kept', 'here');
    git(dir, 'worktree', 'lock', wts.kept);
    fs.rmSync(wts.gone, { recursive: true, force: true });
    fs.rmSync(wts.kept, { recursive: true, force: true });
    const entry = { id: 'worktrees/gone', reason: 'gitdir file points to non-existent location' };
    assert.deepEqual(await g.pruneWorktrees(dir, { dryRun: true }), { entries: [entry] });
    assert.equal((await g.worktrees(dir)).length, 4, 'nothing removed by the dry run');
    assert.deepEqual(await g.pruneWorktrees(dir), { entries: [entry] });
    assert.deepEqual(sorted(await g.worktrees(dir)).map((w) => w.path), [dir, wts.here, wts.kept]);
    assert.deepEqual(await g.pruneWorktrees(dir), { entries: [] });
  });

  test('lockWorktree with a reason, then unlockWorktree; the main worktree is main-worktree', async () => {
    const { dir, wts } = withWorktrees('a');
    assert.deepEqual(await g.lockWorktree(dir, wts.a, { reason: '-on a stick' }), { path: wts.a });
    let a = (await g.worktrees(dir))[1];
    assert.deepEqual([a.locked, a.lockReason], [true, '-on a stick']);
    assert.deepEqual(await g.unlockWorktree(dir, wts.a), { path: wts.a });
    a = (await g.worktrees(dir))[1];
    assert.deepEqual([a.locked, a.lockReason], [false, null]);
    await g.lockWorktree(dir, wts.a);
    assert.deepEqual([(await g.worktrees(dir))[1].locked, (await g.worktrees(dir))[1].lockReason], [true, null]);
    await assert.rejects(g.lockWorktree(dir, dir), { kind: 'main-worktree' });
    await assert.rejects(g.unlockWorktree(dir, dir), { kind: 'main-worktree' });
  });

  test('worktreesDirty: clean, modified and untracked; prunable and current ones left out; a timeout is null; the cap', async () => {
    const { dir, wts } = withWorktrees('clean', 'mod', 'untr', 'gone');
    write(wts.mod, 'README.md', 'changed\n');
    write(wts.untr, 'new.txt', 'n\n');
    write(dir, 'main-dirty.txt', 'x\n'); // the current one is never checked
    fs.rmSync(wts.gone, { recursive: true, force: true });
    assert.deepEqual(byName(await g.worktreesDirty(dir)), [
      { path: wts.clean, dirty: false }, { path: wts.mod, dirty: true }, { path: wts.untr, dirty: true },
    ]);
    // From a linked worktree the main one is checked and the tab's own is not.
    assert.deepEqual(byName(await g.worktreesDirty(wts.clean)), byName([dir, wts.mod, wts.untr].map((p) => ({ path: p, dirty: true }))));
    const capped = await g.worktreesDirty(dir, { max: 1, concurrency: 1 });
    assert.equal(capped.length, 3);
    assert.deepEqual(capped.slice(1).map((w) => w.dirty), [null, null], 'beyond the cap: unknown');
    assert.notEqual(capped[0].dirty, null, 'the first one is checked');
    assert.deepEqual(await g.worktreesDirty(path.join(tmpDir(), 'not-a-repo')), [], 'never rejects');
  });

  /** A clean filter that leaves `marker` when it runs, for the trust gate's tests. */
  const markingFilter = (marker) => `sh -c 'touch "${marker}"; cat'`;
  /** Arm `wt` so `status` there runs filter `name` (configure it afterwards): x.txt uses it, and its stat no longer matches the index. */
  function armFilter(wt, name) {
    write(wt, '.gitattributes', `x.txt filter=${name}\n`);
    commitFile(wt, 'x.txt', 'x\n', 'x');
    git(wt, 'add', '.gitattributes');
    git(wt, 'commit', '-q', '-m', 'attrs');
    write(wt, 'x.txt', 'y\n'); // same size, newer mtime: status must hash it through the filter
  }

  test('worktreesDirty: a clean filter set only for another worktree (config.worktree, includeIf) never runs; null', async () => {
    // The reviewer's repro: .git/worktrees/<id>/config.worktree sets filter.evil.clean; the
    // tab's own config (what the trust prompt saw) sets nothing that runs a command.
    const { dir, wts } = withWorktrees('evil', 'inc', 'ok');
    const marker = path.join(tmpDir(), 'PWNED');
    armFilter(wts.evil, 'evil');
    armFilter(wts.inc, 'inc');
    git(dir, 'config', 'extensions.worktreeConfig', 'true');
    git(wts.evil, 'config', '--worktree', 'filter.evil.clean', markingFilter(marker));
    // An include that applies only in that worktree (includeIf gitdir: its own git dir).
    const inc = path.join(tmpDir(), 'inc.cfg');
    fs.writeFileSync(inc, `[filter "inc"]\n\tclean = ${markingFilter(marker)}\n`);
    const incGitDir = git(wts.inc, 'rev-parse', '--absolute-git-dir').trim();
    git(dir, 'config', `includeIf.gitdir:${incGitDir}.path`, inc);
    write(wts.ok, 'new.txt', 'n\n');
    assert.deepEqual(byName(await g.worktreesDirty(dir)), byName([
      { path: wts.evil, dirty: null }, { path: wts.inc, dirty: null }, { path: wts.ok, dirty: true },
    ]));
    assert.equal(fs.existsSync(marker), false, 'no filter ran');
    // The setup is armed: a plain status there does run it.
    git(wts.evil, 'status', '--porcelain');
    assert.equal(fs.existsSync(marker), true);
  });

  test('worktreesDirty: risky config the tab\'s own folder has too (the user opened it) is no reason to skip', async () => {
    const { dir, wts } = withWorktrees('a');
    const marker = path.join(tmpDir(), 'ran');
    git(dir, 'config', 'filter.shared.clean', markingFilter(marker)); // local: every worktree reads it
    armFilter(wts.a, 'shared');
    assert.deepEqual(await g.worktreesDirty(dir), [{ path: wts.a, dirty: true }]);
    // The same key set in the worktree's own config, with another value: trusted by name, as the trust store does.
    git(dir, 'config', 'extensions.worktreeConfig', 'true');
    git(wts.a, 'config', '--worktree', 'filter.shared.clean', 'cat');
    assert.deepEqual(await g.worktreesDirty(dir), [{ path: wts.a, dirty: true }]);
    // A key only the worktree has: skipped.
    git(wts.a, 'config', '--worktree', 'core.sshCommand', 'ssh');
    assert.deepEqual(await g.worktreesDirty(dir), [{ path: wts.a, dirty: null }]);
  });

  test('worktreesDirty: a worktree whose .git file points at another repository is not checked', async () => {
    const { dir, wts } = withWorktrees('a', 'b');
    const other = initRepo();
    write(wts.a, 'new.txt', 'n\n');
    write(other, 'other.txt', 'o\n');
    fs.writeFileSync(path.join(wts.b, '.git'), `gitdir: ${path.join(other, '.git')}\n`);
    assert.deepEqual(byName(await g.worktreesDirty(dir)), byName([{ path: wts.a, dirty: true }, { path: wts.b, dirty: null }]));
  });

  test('worktreesDirty: changes inside a submodule don\'t count (no status runs in it); a moved submodule does', async () => {
    const { dir, wts } = withWorktrees('a');
    const sub = initRepo();
    git(wts.a, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'sm');
    git(wts.a, 'commit', '-q', '-m', 'sm');
    const smDir = path.join(wts.a, 'sm');
    write(smDir, 'untracked.txt', 'u\n');
    write(smDir, 'README.md', 'changed\n');
    assert.deepEqual(await g.worktreesDirty(dir), [{ path: wts.a, dirty: false }]);
    git(smDir, 'config', 'commit.gpgSign', 'false');
    git(smDir, 'commit', '-q', '-am', 'moved');
    assert.deepEqual(await g.worktreesDirty(dir), [{ path: wts.a, dirty: true }]);
  });

  test('worktreeAdminDir: the admin folder whose gitdir points at the worktree (absolute, relative, another spelling)', async () => {
    const { dir, wts } = withWorktrees('a');
    const rel = path.join(path.dirname(wts.a), 'rel');
    git(dir, '-c', 'worktree.useRelativePaths=true', 'worktree', 'add', '-q', '-b', 'rel', rel);
    const { entries } = await g.worktreeList(dir);
    const entry = (p) => entries.find((e) => e.path === p);
    const adminOf = (wt) => fs.realpathSync(git(wt, 'rev-parse', '--absolute-git-dir').trim());
    assert.equal(fs.realpathSync(await g.worktreeAdminDir(dir, entry(wts.a))), adminOf(wts.a));
    assert.equal(fs.readFileSync(path.join(adminOf(rel), 'gitdir'), 'utf8').startsWith('..'), true, 'stored relative');
    assert.equal(fs.realpathSync(await g.worktreeAdminDir(dir, entry(rel))), adminOf(rel));
    // A listed spelling that differs from the gitdir file's (a symlinked parent): matched by real path.
    const link = path.join(tmpDir(), 'link');
    fs.symlinkSync(path.dirname(wts.a), link);
    const viaLink = { ...entry(wts.a), path: path.join(link, 'a') };
    assert.equal(fs.realpathSync(await g.worktreeAdminDir(dir, viaLink)), adminOf(wts.a));
    assert.equal(await g.worktreeAdminDir(dir, entries[0]), null, 'the main worktree has none');
    assert.equal(await g.worktreeAdminDir(initRepo(), entry(wts.a)), null, 'a repo without linked worktrees');
  });

  test('worktrees: a hung realpath is asked once per path, however often the list is read', async (t) => {
    const { dir, wts } = withWorktrees('a', 'hung');
    const saved = fs.promises.realpath;
    let release;
    const hang = new Promise((r) => { release = r; });
    const calls = new Map();
    t.after(() => { fs.promises.realpath = saved; release(); require('../src/fs-paths').resetRealPathOf(); });
    fs.promises.realpath = (p, ...rest) => {
      calls.set(p, (calls.get(p) || 0) + 1);
      return p === wts.hung ? hang.then(() => saved(p, ...rest)) : saved(p, ...rest);
    };
    const t0 = Date.now();
    const first = await g.worktrees(dir);
    assert.ok(Date.now() - t0 >= 1500, 'the first read waited for the timeout');
    for (let i = 0; i < 5; i++) await g.worktrees(dir);
    const t1 = Date.now();
    const again = await g.worktrees(dir);
    assert.ok(Date.now() - t1 < 1500, 'a slow path is answered at once afterwards');
    assert.equal(calls.get(wts.hung), 1, 'one realpath for the hung path');
    assert.ok(calls.get(wts.a) >= 7, 'healthy paths are still asked');
    for (const list of [first, again]) {
      const hung = list.find((w) => w.path === wts.hung);
      assert.deepEqual([hung.missing, hung.current], [false, false], 'unknown: there, and not the tab\'s');
    }
    assert.equal('real' in first[0], false, 'the op\'s answer has no real paths');
  });

  test('worktreesDirty: at most `concurrency` statuses at once; one past its timeout is null', { skip: process.platform === 'win32' }, async (t) => {
    const { dir } = withWorktrees('a', 'b', 'c', 'd', 'e', 'f');
    // A git that logs each status's start and end and holds it for as long as the hold file says.
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    const bin = path.join(tmpDir(), 'git');
    const log = path.join(tmpDir(), 'status.log');
    const hold = path.join(tmpDir(), 'hold');
    fs.writeFileSync(hold, '0.3');
    fs.writeFileSync(bin, `#!/bin/sh
case " $* " in
  *" status "*) echo start >> "${log}"; sleep "$(cat "${hold}")"; "${realGit}" "$@"; rc=$?; echo end >> "${log}"; exit $rc ;;
esac
exec "${realGit}" "$@"
`, { mode: 0o755 });
    const exec = require('../src/exec');
    exec.setGitBinary(bin);
    t.after(() => exec.setGitBinary(null));
    const peak = () => {
      let n = 0;
      let max = 0;
      for (const line of fs.readFileSync(log, 'utf8').split('\n')) {
        if (line === 'start') max = Math.max(max, ++n);
        if (line === 'end') n--;
      }
      return max;
    };
    const res = await g.worktreesDirty(dir, { concurrency: 4 });
    assert.deepEqual(res.map((w) => w.dirty), [false, false, false, false, false, false]);
    assert.equal(peak(), 4, 'six to check, four at a time');
    fs.rmSync(log);
    await g.worktreesDirty(dir, { concurrency: 2 });
    assert.equal(peak(), 2);
    fs.rmSync(log);
    // The timeout covers the config and trust checks too, which run the real git: a budget of a
    // few hundred ms failed now and then on a busy machine (one git start took up to 270 ms) and
    // the list came back empty. A roomy budget against a status held far longer, and the log
    // shows each null is a status that started and was killed, not a check that failed earlier.
    fs.writeFileSync(hold, '30');
    const timed = await g.worktreesDirty(dir, { timeout: 2000, max: 2 });
    assert.deepEqual(timed.map((w) => w.dirty), [null, null, null, null, null, null], 'killed past the timeout: unknown');
    assert.deepEqual(fs.readFileSync(log, 'utf8').split('\n').filter(Boolean), ['start', 'start'], 'the first two started, neither ended');
  });
});
