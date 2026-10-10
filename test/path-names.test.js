'use strict';
// The file names Windows and git don't open as spelled (src/path-names.js): the '.git' aliases and
// the device names, shared by the worktree guard (src/worktree-fs.js) and the clone dialog's name
// check (src/clone-url.js nameError). The guard's own cases stay in test/hunks.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const names = require('../src/path-names');

const win = { platform: 'win32' };
const sup = (n) => String.fromCharCode(n); // superscript digits: 0xb9, 0xb2, 0xb3

test('isDotGitName: .git in any case; on Windows also the 8.3 name and trailing dots or spaces', () => {
  for (const n of ['.git', '.GIT', 'GIT~1', 'git~12', '.git.', '.git  ', 'git~1. ']) assert.equal(names.isDotGitName(n, win), true, n);
  for (const n of ['.gitx', 'git', 'git~', 'git~1x', '.git~1', 'x.git']) assert.equal(names.isDotGitName(n, win), false, n);
  assert.equal(names.isDotGitName('.Git', { platform: 'darwin' }), true);
  assert.equal(names.isDotGitName('GIT~1', { platform: 'linux' }), false);
  assert.equal(names.isDotGitName('.git.', { platform: 'linux' }), false, 'POSIX keeps the trailing dot');
});

test('DEVICE_NAME: the whole name before an extension, any case, trailing spaces', () => {
  for (const n of ['nul', 'NUL.txt', 'nul ', 'con', 'PRN', 'aux.c', 'COM1', 'lpt9.x', 'com0', `COM${sup(0xb9)}`, `lpt${sup(0xb2)}.txt`, 'conin$', 'CONOUT$.x']) {
    assert.equal(names.DEVICE_NAME.test(n), true, n);
  }
  for (const n of ['null', 'nulx.txt', 'console.log', 'com10', 'auxiliary', 'f.nul']) assert.equal(names.DEVICE_NAME.test(n), false, n);
});

test('WIN_INVALID_CHARS; the worktree guard builds its refusedName on the shared rules', () => {
  for (const c of '<>:"|?*') assert.equal(names.WIN_INVALID_CHARS.test(`a${c}b`), true, c);
  assert.equal(names.WIN_INVALID_CHARS.test('a-b.c'), false);
  const guard = require('../src/worktree-fs')._internal;
  assert.equal(guard.isDotGitName, names.isDotGitName, 'one definition');
  assert.equal(names.refusedName, undefined, 'the guard\'s own rule, not the page\'s');
  for (const n of ['..', '.git', 'a.', 'a ', 'a:s', 'nul', 'GIT~1']) assert.equal(guard.refusedName(n, 'win32'), true, n);
  for (const n of ['a.', 'nul', 'GIT~1', 'a:s']) assert.equal(guard.refusedName(n, 'linux'), false, n);
  assert.equal(guard.refusedName('..', 'linux'), true);
  assert.equal(names.defaultPlatform(), process.platform);
});

test('the UMD file works as a plain browser script (window.PLPathNames)', () => {
  const vm = require('node:vm');
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'path-names.js'), 'utf8'), { window });
  assert.equal(window.PLPathNames.isDotGitName('GIT~1', win), true);
  assert.equal(window.PLPathNames.isDotGitName('.git'), true, 'no process: the default platform is not Windows');
  assert.equal(window.PLPathNames.defaultPlatform(), 'linux', 'no process in a page: the renderer passes its own');
});
