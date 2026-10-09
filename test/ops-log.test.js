'use strict';
// What the main-process modules log: the ops runner's per-op records, exec's per-command
// debug records (argv summary, never stdin), watch-session lifecycle, and src/diagnostics.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRunner } = require('../src/ops');
const { createWatchSession } = require('../src/watch-session');
const { crashReporterOptions, listCrashDumps, buildDiagnostics } = require('../src/diagnostics');
const { logger } = require('../src/log');
const exec = require('../src/exec');

function recorder() {
  const records = [];
  const log = { log: (level, msg, fields) => records.push({ level, msg, ...fields }) };
  return { records, log };
}

// ---------------------------------------------------------------- ops runner

test('runner: one record per op with name, repo, write, duration, outcome; never the args', async () => {
  const { records, log } = recorder();
  let t = 1000;
  const fakeOps = {
    status: async () => { t += 5; return 'ok'; },
    commit: async () => { t += 30; return { sha: 'abc' }; },
    push: async () => { t += 7; throw Object.assign(new Error("fatal: unable to access 'https://u:p@h/'"), { kind: 'auth', exitCode: 128 }); },
    boom: async () => { throw new TypeError('x is undefined'); },
  };
  const runner = createRunner({ ops: fakeOps, writeOps: new Set(['commit', 'push']), log, now: () => t });
  await runner.run('/repo', 'status', []);
  await runner.run('/repo', 'commit', ['secret commit message']);
  await assert.rejects(runner.run('/repo', 'push', [{ force: true }]), { kind: 'auth' });
  await assert.rejects(runner.run('/repo', 'boom', []));
  await assert.rejects(runner.run('/repo', 'nope', []), { kind: 'unknown-op' });
  assert.deepEqual(records.map((r) => [r.level, r.msg, r.op, r.write, r.outcome, r.kind || null]), [
    ['debug', 'op done', 'status', false, 'ok', null],
    ['info', 'op done', 'commit', true, 'ok', null],
    ['warn', 'op failed', 'push', true, 'error', 'auth'],
    ['warn', 'op failed', 'boom', false, 'error', null],
    ['warn', 'op failed', 'nope', false, 'error', 'unknown-op'],
  ]);
  assert.deepEqual(records.map((r) => r.ms), [5, 30, 7, 0, 0]);
  assert.ok(records.every((r) => r.repo === '/repo' && r.cancelled === false));
  assert.ok(!JSON.stringify(records).includes('secret commit message'), 'args are never logged');
  assert.equal(records[2].err.kind, 'auth');
});

test("runner: a git error's or a refusal's text (subjects, paths) is never logged, only its kind and code", async () => {
  const { records, log } = recorder();
  const fakeOps = {
    pull: async () => {
      throw exec.tagError(new exec.GitError(['rebase'], 1, 'error: could not apply 1234567... secret subject of a commit\n', ''), 'conflicts');
    },
    rebaseSkip: async () => { throw exec.kindError('dirty', 'Skip would lose secret/path.txt', { paths: ['secret/path.txt'], count: 1 }); },
    boom: async () => { throw new TypeError('x is undefined'); },
  };
  const runner = createRunner({ ops: fakeOps, writeOps: new Set(['pull', 'rebaseSkip']), log });
  await assert.rejects(runner.run('/repo', 'pull', []), { kind: 'conflicts' });
  await assert.rejects(runner.run('/repo', 'rebaseSkip', []), { kind: 'dirty' });
  await assert.rejects(runner.run('/repo', 'boom', []));
  assert.deepEqual(records[0].err, { name: 'GitError', kind: 'conflicts', exitCode: 1 });
  assert.deepEqual(records[1].err, { name: 'Error', kind: 'dirty' });
  const text = JSON.stringify(records);
  assert.ok(!text.includes('secret'), text);
  assert.match(records[2].err.message, /x is undefined/, 'a bug is logged whole');
});

test('runner: a cancelled op is logged at info with cancelled: true', async () => {
  const { records, log } = recorder();
  const fakeOps = {
    fetch: () => new Promise((_resolve, reject) => setTimeout(() => reject(new Error('killed')), 20)),
  };
  const runner = createRunner({ ops: fakeOps, writeOps: new Set(['fetch']), log });
  const p = runner.run('/repo', 'fetch', [], { opId: 'op-1' });
  await new Promise((r) => setImmediate(r));
  assert.equal(runner.cancel('op-1'), true);
  await assert.rejects(p, { kind: 'aborted' });
  assert.equal(records.length, 1);
  assert.equal(records[0].level, 'info');
  assert.equal(records[0].msg, 'op cancelled');
  assert.equal(records[0].outcome, 'cancelled');
  assert.equal(records[0].cancelled, true);
});

// ---------------------------------------------------------------- exec (real git, shared logger)

test('exec: a debug record per git command: argv summary, code, duration; stdin and pathspecs never', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-execlog-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const logs = path.join(dir, 'logs');
  logger.configure({ dir: logs, level: 'debug', mirror: false });
  t.after(() => logger.configure({ dir: null, level: 'info' }));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  await exec.run(repo, ['init', '-q']);
  fs.writeFileSync(path.join(repo, 'private-name.txt'), 'file contents stay out\n');
  await exec.run(repo, ['add', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: 'private-name.txt\0' });
  await exec.run(repo, ['ls-files', '--', 'private-name.txt']);
  await assert.rejects(exec.run(repo, ['rev-parse', '--verify', 'nope^{commit}']));
  await logger.flush();
  const recs = fs.readFileSync(path.join(logs, 'main.log'), 'utf8').trim().split('\n').map(JSON.parse).filter((r) => r.msg === 'git command');
  const text = JSON.stringify(recs);
  assert.ok(!text.includes('private-name'), 'neither stdin nor pathspecs are logged');
  assert.ok(!text.includes('file contents'), 'no contents');
  assert.ok(!text.includes('core.quotePath'), 'the -c overrides are dropped');
  const add = recs.find((r) => r.argv[0] === 'add');
  assert.deepEqual(add.argv, ['add', '--pathspec-from-file=-', '--pathspec-file-nul']);
  assert.equal(add.withStdin, true);
  assert.equal(add.code, 0);
  assert.equal(add.level, 'debug');
  assert.equal(add.scope, 'git');
  assert.ok(Number.isInteger(add.ms));
  assert.deepEqual(recs.find((r) => r.argv[0] === 'ls-files').argv, ['ls-files', '--', '<1 path>']);
  const failed = recs.find((r) => r.argv[0] === 'rev-parse' && r.argv[1] === '--verify');
  assert.equal(failed.failed, true);
  assert.equal(failed.code, 128);
});

test('exec: a timeout is a warning with killed: timeout (and the message stays hidden)', { skip: process.platform === 'win32' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-execlog-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  logger.configure({ dir: path.join(dir, 'logs'), level: 'info', mirror: false });
  t.after(() => logger.configure({ dir: null, level: 'info' }));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repo, 'hooks'), { recursive: true });
  await exec.run(repo, ['init', '-q']);
  fs.writeFileSync(path.join(repo, 'hooks', 'pre-commit'), '#!/bin/sh\nsleep 5\n', { mode: 0o755 });
  const env = { GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@b' };
  await assert.rejects(
    exec.run(repo, ['-c', 'core.hooksPath=hooks', 'commit', '-q', '--allow-empty', '-m', 'my private subject'], { timeout: 200, env }),
    { kind: 'timeout' },
  );
  await logger.flush();
  const recs = fs.readFileSync(path.join(dir, 'logs', 'main.log'), 'utf8').trim().split('\n').map(JSON.parse);
  const rec = recs.find((r) => r.killed === 'timeout');
  assert.ok(rec, 'logged although the level is info');
  assert.equal(rec.level, 'warn');
  assert.deepEqual(rec.argv, ['commit', '-q', '--allow-empty', '-m', '<message>']);
  assert.ok(!JSON.stringify(recs).includes('my private subject'));
});

// ---------------------------------------------------------------- watch session

test('watch session: lifecycle records (watching, stopped, retry, gone) and failures', () => {
  const infos = [];
  const warns = [];
  let onEvent = null;
  let fail = false;
  let t = 0;
  const session = createWatchSession({
    createWatcher: (_root, o) => {
      if (fail) throw new Error('EMFILE: too many open files');
      onEvent = o.onEvent;
      return { pause() {}, resume() {}, close() {} };
    },
    send: () => {},
    now: () => t,
    log: (m, e) => warns.push([m, e && e.message]),
    info: (m, f) => infos.push([m, f.repo]),
  });
  session.open('/r');
  session.open('/s');
  onEvent({ kinds: ['gone'] });
  t = 60000;
  fail = true;
  session.retry();
  session.close();
  assert.deepEqual(infos, [
    ['watching', '/r'], ['stopped watching', '/r'], ['watching', '/s'], ['watched folder is gone', '/s'], ['retrying the watcher', '/s'],
  ]);
  assert.deepEqual(warns, [['could not watch /s:', 'EMFILE: too many open files']]);
});

// ---------------------------------------------------------------- diagnostics

test('crash reporter options: never uploads (an opt-in uploader does not exist yet)', () => {
  assert.deepEqual(crashReporterOptions(), { uploadToServer: false, compress: true });
  assert.deepEqual(crashReporterOptions({ optIn: true }), { uploadToServer: false, compress: true });
});

test('listCrashDumps: .dmp files under Crashpad folders, newest first', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-dumps-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'completed'));
  fs.mkdirSync(path.join(dir, 'pending'));
  fs.writeFileSync(path.join(dir, 'completed', 'old.dmp'), '');
  fs.writeFileSync(path.join(dir, 'pending', 'new.dmp'), '');
  fs.writeFileSync(path.join(dir, 'settings.dat'), '');
  fs.utimesSync(path.join(dir, 'completed', 'old.dmp'), new Date(2020, 0, 1), new Date(2020, 0, 1));
  assert.deepEqual(listCrashDumps(dir).map((d) => d.rel), [path.join('pending', 'new.dmp'), path.join('completed', 'old.dmp')]);
  assert.equal(listCrashDumps(dir, { limit: 1 }).length, 1);
  assert.deepEqual(listCrashDumps(path.join(dir, 'missing')), []);
  assert.deepEqual(listCrashDumps(null), []);
});

test('buildDiagnostics: versions, folders, dumps and log lines, redacted, nothing else', () => {
  const home = os.homedir();
  const text = buildDiagnostics({
    app: { name: 'Pasta Lite', version: '0.1.0', packaged: false },
    versions: { electron: '44.4.5', chrome: '140.0', node: '24.21.0', v8: '14.0' },
    platform: { platform: 'darwin', release: '24.6.0', arch: 'arm64' },
    git: { version: '2.51.0', path: '/opt/homebrew/bin/git' },
    logDir: path.join(home, 'Library/Logs/Pasta Lite'),
    crashDir: path.join(home, 'Library/Application Support/Pasta Lite/Crashpad'),
    dumps: [{ rel: 'completed/abc.dmp', mtime: Date.UTC(2026, 8, 25) }],
    lines: [`{"msg":"push to https://u:${'ghp' + '_1234567890abcdefghijABCDEFGHIJ'}@github.com/o/r failed"}`],
  });
  assert.match(text, /^Pasta Lite 0\.1\.0 \(unpackaged\)$/m);
  assert.match(text, /^Electron 44\.4\.5 · Chrome 140\.0 · Node 24\.21\.0 · V8 14\.0$/m);
  assert.match(text, /^OS: darwin 24\.6\.0 \(arm64\)$/m);
  assert.match(text, /^git: 2\.51\.0 \(\/opt\/homebrew\/bin\/git\)$/m);
  assert.ok(text.split('\n').includes(`Logs: ${path.join('~', 'Library/Logs/Pasta Lite')}`), text);
  assert.match(text, /^ {2}completed\/abc\.dmp {2}2026-09-25T00:00:00\.000Z$/m);
  assert.match(text, /^Last 1 log lines:$/m);
  assert.match(text, /https:\/\/\*\*\*@github\.com/);
  assert.ok(!text.includes('ghp_'));
  assert.ok(!text.includes(home));
  const empty = buildDiagnostics({ app: { name: 'K', version: '1', packaged: true }, git: {}, dumps: [], lines: [] });
  assert.match(empty, /git: not found/);
  assert.match(empty, /Recent crash dumps \(0\):\n {2}\(none\)/);
});
