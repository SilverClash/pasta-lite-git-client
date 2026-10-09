'use strict';
// Windows only: repositories as Git for Windows' own defaults make them, which test/helpers.js's
// global config turns off for every other test (core.hideDotFiles=false, core.symlinks=true).
// Here, as on a user's PC: git hides the .git it creates (core.hideDotFiles=dotGitOnly; `true`
// hides every dotfile it checks out too), and core.symlinks=false (no symlink privilege without
// Developer Mode), so git checks a symlink out as a plain file holding its target. Node can't open
// a hidden file with 'w' (CREATE_ALWAYS: EPERM), so these go through the product's own writes:
// hunk and line actions, discards, and undo / redo restoring the backup.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { tmpDir, git, write, read, commitFile, cleanup } = require('./helpers');
const ops = require('../src/ops');

after(cleanup);

const skip = process.platform !== 'win32' && "Git for Windows' defaults: Windows only";

/** A new repository with branch main, made with `hideDotFiles` (Git for Windows' default: dotGitOnly) and core.symlinks=false. */
function defaultsRepo(hideDotFiles = 'dotGitOnly') {
  const dir = tmpDir();
  git(dir, '-c', `core.hideDotFiles=${hideDotFiles}`, '-c', 'core.symlinks=false', 'init', '-q', '-b', 'main');
  git(dir, 'config', 'core.hideDotFiles', hideDotFiles);
  git(dir, 'config', 'core.symlinks', 'false');
  git(dir, 'config', 'commit.gpgSign', 'false');
  return dir;
}

/** Whether `p` has the Windows hidden attribute (attrib prints its letters before the path). */
function hidden(p) {
  const out = execFileSync('attrib', [p], { encoding: 'utf8' });
  return out.slice(0, out.search(/[A-Za-z]:\\/)).includes('H');
}

/** Rewrite an existing (maybe hidden) file in place, as an editor does: 'w' would be refused. */
function overwrite(p, text) {
  const fd = fs.openSync(p, 'r+');
  try {
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, text);
  } finally {
    fs.closeSync(fd);
  }
}

const BASE = Array.from({ length: 20 }, (_, i) => `line ${i}\n`).join('');
const EDITED = BASE.replace('line 1\n', 'LINE 1\n').replace('line 18\n', 'LINE 18\n');
const TOP_ONLY = BASE.replace('line 1\n', 'LINE 1\n');

/** The fingerprint of `file`'s working-tree diff, as the diff view hands it to a line action. */
const fingerprintOf = async (runner, dir, file) => (await runner.run(dir, 'workdirDiffView', [file])).fingerprint;

/** Stage the top hunk, discard the bottom one, then undo and redo that discard. */
async function hunkRoundTrip(dir, file) {
  const runner = ops.createRunner();
  await runner.run(dir, 'stageSelection', [file, [{ hunk: 0 }], { fingerprint: await fingerprintOf(runner, dir, file) }]);
  assert.equal(git(dir, 'show', `:${file}`), TOP_ONLY);
  // The index -> worktree diff now has the bottom hunk only.
  const fingerprint = await fingerprintOf(runner, dir, file);
  const { backup } = await runner.run(dir, 'discardSelection', [file, [{ hunk: 0 }], { fingerprint }]);
  assert.match(backup, /^[0-9a-f]{40}$/);
  assert.equal(read(dir, file), TOP_ONLY);
  await runner.run(dir, 'undo');
  assert.equal(read(dir, file), EDITED);
  await runner.run(dir, 'redo');
  assert.equal(read(dir, file), TOP_ONLY);
  return runner;
}

test('a hidden .git: line staging, a hunk discard and its undo / redo; a whole-file discard of a tracked and an untracked file', { skip }, async () => {
  const dir = defaultsRepo();
  assert.ok(hidden(path.join(dir, '.git')), 'git hid the .git it made');
  commitFile(dir, 'f.txt', BASE);
  write(dir, 'f.txt', EDITED);
  const runner = await hunkRoundTrip(dir, 'f.txt');

  write(dir, 'new.txt', 'untracked\n');
  const st = await runner.run(dir, 'status');
  await runner.run(dir, 'discard', [st.unstaged]);
  assert.equal(read(dir, 'f.txt'), TOP_ONLY); // the staged hunk stays
  assert.equal(fs.existsSync(path.join(dir, 'new.txt')), false);
  await runner.run(dir, 'undo');
  assert.equal(read(dir, 'f.txt'), TOP_ONLY);
  assert.equal(read(dir, 'new.txt'), 'untracked\n');
});

test('a linked worktree whose .git file is hidden: a hunk discard and its undo / redo', { skip }, async () => {
  const main = defaultsRepo();
  commitFile(main, 'f.txt', BASE);
  const wt = path.join(tmpDir(), 'wt');
  git(main, 'worktree', 'add', '-q', '-b', 'side', wt);
  assert.ok(hidden(path.join(wt, '.git')), "git hid the worktree's .git file");
  write(wt, 'f.txt', EDITED);
  await hunkRoundTrip(wt, 'f.txt');
});

test('core.hideDotFiles=true: a hidden dotfile git checked out is changed in place by a hunk discard and its undo', { skip }, async () => {
  const dir = defaultsRepo('true');
  const file = path.join(dir, '.env.sample');
  commitFile(dir, '.env.sample', BASE);
  fs.rmSync(file);
  git(dir, 'checkout', '--', '.env.sample'); // git makes it again, hidden
  assert.ok(hidden(file), 'git hid the dotfile it checked out');
  overwrite(file, EDITED);
  await hunkRoundTrip(dir, '.env.sample');
  assert.ok(hidden(file), 'still the same hidden file');
});

test('core.symlinks=false: a symlink checked out as a plain file is discarded, and undo puts it back as a plain file', { skip }, async () => {
  const dir = defaultsRepo();
  commitFile(dir, 'target.txt', 'the target\n');
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, input: 'target.txt', encoding: 'utf8' }).trim();
  git(dir, 'update-index', '--add', '--cacheinfo', `120000,${blob},lnk`);
  git(dir, 'commit', '-q', '-m', 'link');
  git(dir, 'checkout', '--', 'lnk');
  const lnk = path.join(dir, 'lnk');
  const plainFile = (what) => {
    const st = fs.lstatSync(lnk);
    assert.ok(st.isFile() && !st.isSymbolicLink(), `${what}: a plain file, as git checks a link out with core.symlinks=false`);
  };
  plainFile('checked out');
  assert.equal(read(dir, 'lnk'), 'target.txt');
  assert.equal(git(dir, 'status', '--porcelain'), '');

  write(dir, 'lnk', 'elsewhere.txt');
  const runner = ops.createRunner();
  // Line and hunk actions refuse a link, whatever is on disk.
  const fingerprint = await fingerprintOf(runner, dir, 'lnk');
  await assert.rejects(runner.run(dir, 'discardSelection', ['lnk', [{ hunk: 0 }], { fingerprint }]), (e) => e.kind === 'symlink');
  const st = await runner.run(dir, 'status');
  assert.deepEqual(st.unstaged.map((f) => f.path), ['lnk']);
  await runner.run(dir, 'discard', [st.unstaged]);
  plainFile('discarded');
  assert.equal(read(dir, 'lnk'), 'target.txt');

  await runner.run(dir, 'undo');
  plainFile('restored by undo');
  assert.equal(read(dir, 'lnk'), 'elsewhere.txt');
  assert.equal(git(dir, 'status', '--porcelain'), ' M lnk\n');
  await runner.run(dir, 'redo');
  plainFile('discarded again by redo');
  assert.equal(read(dir, 'lnk'), 'target.txt');
});
