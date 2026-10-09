'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findOnPath } = require('../src/shell');

// ---------------------------------------------------------------- findOnPath

test('findOnPath: absolute PATH entries only (empty, "." and relative ones skipped), first match wins', () => {
  const seen = [];
  const isFile = (p) => { seen.push(p); return p === '/b/git' || p === '/c/git' || p === 'git' || p === 'rel/git'; };
  assert.equal(findOnPath('git', { env: { PATH: '::.:rel:/a:/b:/c' }, platform: 'linux', isFile }), '/b/git');
  assert.deepEqual(seen, ['/a/git', '/b/git'], 'cwd-relative entries are never probed');
  assert.equal(findOnPath('git', { env: { PATH: '.:rel' }, platform: 'linux', isFile }), null);
  assert.equal(findOnPath('git', { env: {}, platform: 'linux', isFile }), null);
  // Windows: ';' separator, the 'Path' key spelling, quoted entries, drive paths.
  const win = new Set(['C:\\Git\\cmd\\git.exe']);
  assert.equal(findOnPath('git.exe', { env: { Path: '.;;"C:\\Git\\cmd";D:\\x' }, platform: 'win32', isFile: (p) => win.has(p) }), 'C:\\Git\\cmd\\git.exe');
  assert.equal(findOnPath('git.exe', { env: { Path: '.;cmd' }, platform: 'win32', isFile: () => true }), null);
});

test('findOnPath: the default check wants an executable regular file (on Windows: any regular file)', (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-which-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  fs.writeFileSync(path.join(d, 'plain'), 'x', { mode: 0o644 });
  fs.writeFileSync(path.join(d, 'tool'), '#!/bin/sh\n', { mode: 0o755 });
  fs.mkdirSync(path.join(d, 'dir'));
  const env = { PATH: d };
  assert.equal(findOnPath('tool', { env }), path.join(d, 'tool'));
  assert.equal(findOnPath('plain', { env }), process.platform === 'win32' ? path.join(d, 'plain') : null);
  assert.equal(findOnPath('dir', { env }), null);
});

test('shell re-exports the PATH lookup (which.js) and the git-failure text (gitcheck.js)', () => {
  const shell = require('../src/shell');
  const which = require('../src/which');
  assert.equal(shell.findOnPath, which.findOnPath);
  assert.equal(shell.isRunnable, which.isRunnable);
  assert.equal(shell.describeGitFailure, require('../src/gitcheck').describeGitFailure);
});
