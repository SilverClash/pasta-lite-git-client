'use strict';
// A submodule's own config and hooks: the app's git never works inside a submodule where a flag
// or a -c override can stop it (status, diffs, checkout, fetch, push; src/git-process.js,
// src/working-state.js, src/diff-args.js, src/remote.js). The markers below are only ever
// touched by a program that the submodule's own config or hooks name.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, git, initRepo, write, commitFile, cleanup } = require('./helpers');
const g = require('../src/git');

after(cleanup);

const allowFile = ['-c', 'protocol.file.allow=always'];

/**
 * A superproject `dir` with a populated submodule `sub` (git dir in .git/modules/sub), and
 * .gitmodules asking git to look inside it for everything it can (ignore = none,
 * fetchRecurseSubmodules = true), as a downloaded repo could. `marker`: a path no program has
 * touched yet.
 */
function superWithSubmodule() {
  const subSrc = initRepo();
  const dir = initRepo();
  git(dir, ...allowFile, 'submodule', 'add', '-q', subSrc, 'sub');
  git(dir, 'config', '-f', '.gitmodules', 'submodule.sub.ignore', 'none');
  git(dir, 'config', '-f', '.gitmodules', 'submodule.sub.fetchRecurseSubmodules', 'true');
  git(dir, 'add', '.gitmodules');
  git(dir, 'commit', '-q', '-m', 'add sub');
  const sub = path.join(dir, 'sub');
  git(sub, 'config', 'commit.gpgSign', 'false');
  return { dir, sub, subSrc, marker: path.join(tmpDir(), 'ran') };
}

/** The submodule's own config sets a clean filter for every file (it touches `marker`). */
function subFilter({ sub, marker }) {
  git(sub, 'config', 'filter.x.clean', `touch '${marker}'; cat`);
  write(sub, '.gitattributes', '* filter=x\n');
}

let tick = 2000000000;
/** Give the submodule's README.md a new mtime, so a status inside the submodule must read it (through the filter). */
function touchSubFile({ sub }) {
  tick += 10;
  fs.utimesSync(path.join(sub, 'README.md'), tick, tick);
}

const ran = (marker) => fs.existsSync(marker);

describe('the app\'s git never works inside a submodule', () => {
  test('status and working-tree diffs don\'t run a submodule\'s filter, whatever .gitmodules says', async () => {
    const s = superWithSubmodule();
    subFilter(s);
    write(s.dir, 'top.txt', 'changed\n');
    touchSubFile(s);
    // What a git that looks inside the submodule does (and what these commands did before).
    git(s.dir, 'status', '--porcelain');
    assert.equal(ran(s.marker), true, 'a plain status runs it');
    fs.rmSync(s.marker);

    touchSubFile(s);
    const st = await g.status(s.dir);
    assert.deepEqual(st.unstaged.map((f) => f.path), ['top.txt'], 'changes inside the submodule are not shown');
    await g.diffWorkdir(s.dir, 'sub');
    await g.diffWorkdir(s.dir, 'sub', { staged: true });
    await g.stage(s.dir, ['top.txt']);
    assert.equal(ran(s.marker), false);
  });

  test('a moved submodule still shows in status and as a one-line diff', async () => {
    const s = superWithSubmodule();
    commitFile(s.sub, 'new.txt', 'n\n', 'moved');
    const st = await g.status(s.dir);
    assert.deepEqual(st.unstaged.map((f) => f.path), ['sub']);
    const patch = await g.diffWorkdir(s.dir, 'sub');
    assert.match(patch, /^-Subproject commit [0-9a-f]{40}$/m);
    assert.match(patch, /^\+Subproject commit [0-9a-f]{40}$/m);
  });

  test('checkout and branch switches don\'t recurse into a submodule (its hooks never run)', async () => {
    const s = superWithSubmodule();
    git(s.dir, 'config', 'submodule.recurse', 'true');
    git(s.dir, 'checkout', '-q', '-b', 'other');
    commitFile(s.sub, 'new.txt', 'n\n', 'moved');
    git(s.dir, 'add', 'sub');
    git(s.dir, 'commit', '-q', '-m', 'move sub');
    git(s.dir, 'checkout', '-q', 'main'); // recurses: the submodule is back at main's commit
    const hook = path.join(s.dir, '.git', 'modules', 'sub', 'hooks', 'reference-transaction');
    write(path.dirname(hook), 'reference-transaction', `#!/bin/sh\ntouch '${s.marker}'\n`);
    fs.chmodSync(hook, 0o755);
    if (process.platform !== 'win32') {
      git(s.dir, 'checkout', '-q', 'other');
      assert.equal(ran(s.marker), true, 'a git that recurses runs it');
      git(s.dir, 'checkout', '-q', 'main');
      fs.rmSync(s.marker);
    }

    await g.checkout(s.dir, 'other');
    await g.checkout(s.dir, 'main');
    await g.createBranch(s.dir, 'third', { start: 'other', checkout: true });
    assert.equal(ran(s.marker), false);
  });

  test('fetch and push never recurse into a submodule, whatever the config or .gitmodules says', async (t) => {
    const s = superWithSubmodule();
    const origin = path.join(tmpDir(), 'origin.git');
    git(s.dir, 'clone', '-q', '--bare', s.dir, origin);
    git(s.dir, 'remote', 'add', 'origin', origin);
    git(s.dir, 'fetch', '-q', 'origin');
    git(s.dir, 'branch', '-q', '--set-upstream-to=origin/main', 'main');
    git(s.dir, 'config', 'fetch.recurseSubmodules', 'true');
    git(s.dir, 'config', 'push.recurseSubmodules', 'on-demand');
    // The submodule's own remote runs a program on fetch and on push (local transport).
    git(s.sub, 'config', 'remote.origin.uploadpack', `touch '${s.marker}'; git-upload-pack`);
    git(s.sub, 'config', 'remote.origin.receivepack', `touch '${s.marker}'; git-receive-pack`);
    // A submodule commit the superproject records but the submodule's remote lacks: what an
    // on-demand push would push first.
    commitFile(s.sub, 'new.txt', 'n\n', 'moved');
    git(s.dir, 'add', 'sub');
    git(s.dir, 'commit', '-q', '-m', 'move sub');
    // Submodule fetches over a local path need protocol.file.allow (global config here, so the
    // repo's own config stays as a downloaded one could have it).
    const globalCfg = path.join(tmpDir(), 'global.cfg');
    fs.writeFileSync(globalCfg, '[protocol "file"]\n\tallow = always\n');
    const saved = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = globalCfg;
    t.after(() => { process.env.GIT_CONFIG_GLOBAL = saved; });

    await g.fetch(s.dir);
    await g.fetch(s.dir, { remote: 'origin' });
    await g.push(s.dir, { remote: 'origin', branch: 'main' });
    assert.equal(ran(s.marker), false);
    git(s.dir, 'fetch', '-q', 'origin');
    assert.equal(ran(s.marker), true, 'a git that recurses runs it');
  });
});

describe('the trust check reads every submodule and worktree (git.riskyNested)', () => {
  const executable = (file, body) => {
    write(path.dirname(file), path.basename(file), body);
    fs.chmodSync(file, 0o755);
  };

  test('a populated submodule\'s config and hooks are listed; add -A and stash push run them (what the check guards against)', async () => {
    const s = superWithSubmodule();
    assert.deepEqual(await g.riskyNested(s.dir), [], 'a plain submodule: nothing');
    subFilter(s);
    executable(path.join(s.dir, '.git', 'modules', 'sub', 'hooks', 'post-checkout'), '#!/bin/sh\n');
    assert.deepEqual(await g.riskyNested(s.dir), ['submodule sub: filter.x.clean', 'submodule sub: hooks/post-checkout']);
    assert.deepEqual(await g.riskyLocalConfig(s.dir), [], 'the superproject\'s own config is clean');
    // Nothing turns these off for a submodule .gitmodules marks `ignore = none`:
    touchSubFile(s);
    await g.stageAll(s.dir);
    assert.equal(ran(s.marker), true, 'add -A');
    fs.rmSync(s.marker);
    write(s.dir, 'README.md', 'changed\n');
    touchSubFile(s);
    await g.stashPush(s.dir);
    assert.equal(ran(s.marker), true, 'stash push');
  });

  test('submodules inside submodules, and git dirs in .git/modules with no checkout, are listed too', async () => {
    const s = superWithSubmodule();
    const inner = initRepo();
    git(s.sub, ...allowFile, 'submodule', 'add', '-q', inner, 'inner');
    git(s.sub, 'commit', '-q', '-m', 'inner');
    const innerDir = path.join(s.sub, 'inner');
    git(innerDir, 'config', 'core.sshCommand', 'ssh -o x');
    // A second submodule, deinitialised: its git dir stays in .git/modules, a checkout can bring it back.
    const other = initRepo();
    git(s.dir, ...allowFile, 'submodule', 'add', '-q', other, 'libs/other');
    git(s.dir, 'commit', '-q', '-m', 'other');
    git(path.join(s.dir, 'libs', 'other'), 'config', 'credential.helper', 'store');
    git(s.dir, 'submodule', 'deinit', '-q', '-f', 'libs/other');
    assert.equal(fs.existsSync(path.join(s.dir, 'libs', 'other', '.git')), false);
    assert.deepEqual(await g.riskyNested(s.dir), [
      'submodule modules/libs/other: credential.helper',
      'submodule sub/inner: core.sshcommand',
    ]);
  });

  test('a gitlink folder whose .git is broken is not a submodule git looks into: skipped', async () => {
    const s = superWithSubmodule();
    fs.rmSync(path.join(s.sub, '.git'));
    write(s.sub, '.git', 'gitdir: /nowhere\n');
    fs.rmSync(path.join(s.dir, '.git', 'modules'), { recursive: true });
    assert.deepEqual(await g.riskyNested(s.dir), []);
  });

  test('another worktree\'s own config is listed; `git worktree remove` runs status there with it', async () => {
    const dir = initRepo();
    const marker = path.join(tmpDir(), 'ran');
    const wt = path.join(tmpDir(), 'wt');
    git(dir, 'worktree', 'add', '-q', '-b', 'side', wt);
    git(dir, 'config', 'extensions.worktreeConfig', 'true');
    git(wt, 'config', '--worktree', 'filter.x.clean', `touch '${marker}'; cat`);
    const id = path.basename(git(wt, 'rev-parse', '--absolute-git-dir').trim());
    assert.deepEqual(await g.riskyLocalConfig(dir), [], 'the main worktree\'s own config is clean');
    assert.deepEqual(await g.riskyNested(dir), [`worktree worktrees/${id}: filter.x.clean`]);
    // From the linked worktree it is its own config, and the main worktree has nothing extra.
    assert.deepEqual(await g.riskyLocalConfig(wt), ['filter.x.clean']);
    assert.deepEqual(await g.riskyNested(wt), []);
    // An includeIf that holds only on the other worktree's branch.
    const inc = path.join(tmpDir(), 'side.cfg');
    fs.writeFileSync(inc, '[core]\n\tsshCommand = ssh -o y\n');
    git(dir, 'config', 'includeIf.onbranch:side.path', inc);
    assert.deepEqual(await g.riskyNested(dir), [`worktree worktrees/${id}: core.sshcommand`, `worktree worktrees/${id}: filter.x.clean`]);

    // What it guards against: a clean check of the worktree before removing it.
    write(wt, '.gitattributes', '* filter=x\n');
    git(wt, 'add', '.gitattributes');
    git(wt, 'commit', '-q', '-m', 'attrs');
    fs.rmSync(marker, { force: true });
    fs.utimesSync(path.join(wt, 'README.md'), 2100000000, 2100000000);
    await g.removeWorktree(dir, wt);
    assert.equal(ran(marker), true);
  });
});
