'use strict';
// src/cli-args.js: the main process command line (a repo, --smoke, packaged builds).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { parseArgs } = require('../src/cli-args');

const CWD = '/work/here';
// The expected paths as POSIX spells them; on Windows path.resolve puts them on the current drive.
const P = (p) => (process.platform === 'win32' ? path.resolve(p) : p);

test('parseArgs: unpackaged `electron .` (npm start -- <path>)', () => {
  const o = { cwd: CWD, defaultApp: true };
  assert.deepEqual(parseArgs(['/x/electron', '.'], o), { repo: null, smoke: null });
  assert.deepEqual(parseArgs(['/x/electron', '.', '/abs/repo'], o), { repo: P('/abs/repo'), smoke: null });
  assert.deepEqual(parseArgs(['/x/electron', '.', 'rel/repo'], o), { repo: P('/work/here/rel/repo'), smoke: null });
  assert.deepEqual(parseArgs(['/x/electron', '.', '..'], o), { repo: P('/work'), smoke: null });
  // The app path itself is never taken as the repo.
  assert.deepEqual(parseArgs(['/x/electron', '/path/to/app'], o), { repo: null, smoke: null });
  assert.deepEqual(parseArgs(['/x/electron'], o), { repo: null, smoke: null });
});

test('parseArgs: Electron / Chromium flags before and after the app path are ignored', () => {
  const o = { cwd: CWD, defaultApp: true };
  assert.deepEqual(parseArgs(['/x/electron', '--inspect=9229', '--enable-logging', '.', '--no-sandbox', 'repo'], o),
    { repo: P('/work/here/repo'), smoke: null });
  // Flags a second instance forwards (Chromium appends its own).
  assert.deepEqual(parseArgs(['/x/electron', '.', 'repo', '--allow-file-access-from-files', '--original-process-start-time=1'], o),
    { repo: P('/work/here/repo'), smoke: null });
});

test('parseArgs: packaged app (no app path in argv)', () => {
  const o = { cwd: CWD, defaultApp: false };
  assert.deepEqual(parseArgs(['/Applications/Pasta Lite.app/Contents/MacOS/Pasta Lite'], o), { repo: null, smoke: null });
  assert.deepEqual(parseArgs(['/A/Pasta Lite', 'repo'], o), { repo: P('/work/here/repo'), smoke: null });
  assert.deepEqual(parseArgs(['/A/Pasta Lite', '-psn_0_12345', '/r'], o), { repo: P('/r'), smoke: null });
  // Only the first positional is the repo.
  assert.deepEqual(parseArgs(['/A/Pasta Lite', 'a', 'b'], o), { repo: P('/work/here/a'), smoke: null });
});

test('parseArgs: --smoke forms', () => {
  const o = { cwd: CWD, defaultApp: true };
  assert.deepEqual(parseArgs(['/x/electron', '.', '--smoke', 'repo', 'out.png'], o),
    { repo: null, smoke: { repo: P('/work/here/repo'), out: P('/work/here/out.png') } });
  assert.deepEqual(parseArgs(['/x/electron', '.', '--smoke', '/tmp/w.png'], o),
    { repo: null, smoke: { repo: null, out: P('/tmp/w.png') } });
  assert.deepEqual(parseArgs(['/x/electron', '.', '--smoke'], o), { repo: null, smoke: { repo: null, out: null } });
  // Flags between the smoke args are skipped; positionals before --smoke don't count.
  assert.deepEqual(parseArgs(['/x/electron', '.', 'ignored', '--smoke', '--enable-logging', 'r', 'o.png'], o),
    { repo: null, smoke: { repo: P('/work/here/r'), out: P('/work/here/o.png') } });
  // Packaged.
  assert.deepEqual(parseArgs(['/A/Pasta Lite', '--smoke', 'o.png'], { cwd: CWD }), { repo: null, smoke: { repo: null, out: P('/work/here/o.png') } });
});

test('parseArgs: allowSmoke false (packaged) ignores --smoke and its arguments', () => {
  const o = { cwd: CWD, defaultApp: false, allowSmoke: false };
  assert.deepEqual(parseArgs(['/A/Pasta Lite', '--smoke', 'repo', 'out.png'], o), { repo: null, smoke: null });
  assert.deepEqual(parseArgs(['/A/Pasta Lite', 'r', '--smoke', 'o.png'], o), { repo: P('/work/here/r'), smoke: null });
  assert.deepEqual(parseArgs(['/x/electron', '.', '--smoke', 'o.png'], { ...o, defaultApp: true }), { repo: null, smoke: null });
});

test('parseArgs: paths with spaces and odd characters are kept verbatim', () => {
  const o = { cwd: '/a b', defaultApp: true };
  assert.deepEqual(parseArgs(['/x/electron', '.', 'brk[x]/pct%41 é'], o), { repo: P('/a b/brk[x]/pct%41 é'), smoke: null });
});
