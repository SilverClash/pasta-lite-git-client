'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');
const x = require('../src/exec');

test('inherited GIT_DIR / GIT_INDEX_FILE / pathspec vars do not leak into commands', async (t) => {
  const a = h.initRepo();
  const b = h.initRepo();
  h.write(b, 'only-in-b.txt', 'b\n');
  const saved = { ...process.env };
  t.after(() => {
    for (const k of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_GLOB_PATHSPECS']) delete process.env[k];
    Object.assign(process.env, saved);
  });
  process.env.GIT_DIR = path.join(a, '.git');
  process.env.GIT_INDEX_FILE = path.join(a, '.git', 'index');
  process.env.GIT_WORK_TREE = a;
  process.env.GIT_GLOB_PATHSPECS = '1';
  const st = await x.out(b, ['status', '--porcelain']);
  assert.match(st, /only-in-b\.txt/);
  await x.run(b, ['add', '--', 'only-in-b.txt']);
  delete process.env.GIT_DIR;
  delete process.env.GIT_INDEX_FILE;
  delete process.env.GIT_WORK_TREE;
  assert.match(h.git(b, 'diff', '--cached', '--name-only'), /only-in-b\.txt/);
  assert.equal(h.git(a, 'diff', '--cached', '--name-only'), '');
});

test('commands run at the worktree root when given a subdirectory', async () => {
  const dir = h.initRepo();
  h.write(dir, 'sub/deep/f.txt', 'x\n');
  const sub = path.join(dir, 'sub', 'deep');
  assert.equal(await x.resolveRoot(sub), dir);
  await x.run(sub, ['add', '--', 'sub/deep/f.txt']); // root-relative path works from a subdir
  assert.match(h.git(dir, 'diff', '--cached', '--name-only'), /sub\/deep\/f\.txt/);
});

test('resolveRoot leaves non-repositories alone and does not cache them', async () => {
  const d = h.tmpDir();
  assert.equal(await x.resolveRoot(d), d);
  h.git(d, 'init', '-q');
  assert.equal(await x.resolveRoot(d), d);
});

test('timeout kills the git process group and tags the error', async () => {
  const dir = h.initRepo();
  const t0 = Date.now();
  await assert.rejects(
    x.run(dir, ['-c', 'alias.slow=!sleep 5', 'slow'], { timeout: 300 }),
    (e) => e instanceof x.GitError && e.kind === 'timeout',
  );
  assert.ok(Date.now() - t0 < 3000);
});

test('AbortSignal cancels a running command', async () => {
  const dir = h.initRepo();
  const ac = new AbortController();
  const p = x.run(dir, ['-c', 'alias.slow=!sleep 5', 'slow'], { signal: ac.signal });
  setTimeout(() => ac.abort(), 100);
  await assert.rejects(p, (e) => e.kind === 'aborted');
});

test('latin1 and buffer encodings round-trip non-UTF-8 bytes', async () => {
  const dir = h.initRepo();
  const bytes = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a, 0xff, 0x00, 0x0a]);
  fs.writeFileSync(path.join(dir, 'l1.txt'), bytes);
  const sha = (await x.out(dir, ['hash-object', '-w', '--', 'l1.txt'])).trim();
  const asBuf = await x.out(dir, ['cat-file', 'blob', sha], { encoding: 'buffer' });
  assert.ok(Buffer.isBuffer(asBuf) && asBuf.equals(bytes));
  const asL1 = await x.out(dir, ['cat-file', 'blob', sha], { encoding: 'latin1' });
  assert.ok(Buffer.from(asL1, 'latin1').equals(bytes));
  const sha2 = (await x.out(dir, ['hash-object', '-w', '--stdin'], { input: Buffer.from(asL1, 'latin1') })).trim();
  assert.equal(sha2, sha);
});

test('GitError carries exitCode, kindError/tagError carry kind', async () => {
  const dir = h.initRepo();
  await assert.rejects(x.run(dir, ['rev-parse', '--verify', 'nope']), (e) => e.exitCode === 128 && e.kind === undefined);
  const e = x.kindError('stale', 'msg', { extra: 1 });
  assert.equal(e.kind, 'stale');
  assert.equal(e.extra, 1);
  assert.equal(x.tagError(new Error('m'), 'auth').kind, 'auth');
});

test('tryOut returns null on git failure', async () => {
  const dir = h.initRepo();
  assert.equal(await x.tryOut(dir, ['rev-parse', '-q', '--verify', 'nope']), null);
});

test('headState: attached, detached, unborn', async () => {
  const dir = h.initRepo();
  const sha = h.git(dir, 'rev-parse', 'HEAD').trim();
  assert.deepEqual(await x.headState(dir), { sha, branch: 'main' });
  h.git(dir, 'checkout', '-q', '--detach');
  assert.deepEqual(await x.headState(dir), { sha, branch: null });
  const empty = h.initRepo({ commits: false });
  assert.deepEqual(await x.headState(empty), { sha: null, branch: 'main' });
});

test('repoState detects merge, cherry-pick, bisect and clean', async () => {
  const dir = h.initRepo();
  assert.equal(await x.repoState(dir), 'clean');
  h.git(dir, 'checkout', '-q', '-b', 'side');
  h.commitFile(dir, 'README.md', 'side\n');
  const sideSha = h.git(dir, 'rev-parse', 'HEAD').trim();
  h.git(dir, 'checkout', '-q', 'main');
  h.commitFile(dir, 'README.md', 'main\n');
  assert.throws(() => h.git(dir, 'merge', 'side'));
  assert.equal(await x.repoState(dir), 'merging');
  h.git(dir, 'merge', '--abort');
  assert.throws(() => h.git(dir, 'cherry-pick', sideSha));
  assert.equal(await x.repoState(dir), 'cherry-picking');
  h.git(dir, 'cherry-pick', '--abort');
  h.git(dir, 'bisect', 'start');
  assert.equal(await x.repoState(dir), 'bisecting');
  h.git(dir, 'bisect', 'reset');
  assert.equal(await x.repoState(dir), 'clean');
});

test('hostile user config does not change -c overridden output', async () => {
  const dir = h.initRepo();
  h.hostileConfig(dir);
  h.write(dir, 'README.md', 'changed\n');
  const diff = await x.out(dir, ['diff', ...x.DIFF_OPTS], { diff: true });
  assert.doesNotMatch(diff, /\x1b\[/);
  assert.match(diff, /^--- a\/README\.md$/m);
});

test('parseNulRecords (src/porcelain.js) and nulList', () => {
  const { parseNulRecords } = require('../src/porcelain');
  assert.deepEqual(parseNulRecords('a\0b\0\nc\0d\0', 2), [['a', 'b'], ['c', 'd']]);
  assert.deepEqual(parseNulRecords('', 2), []);
  assert.equal(x.nulList(['a b', 'c']), 'a b\0c\0');
});

test('withSignal: ambient AbortSignal cancels commands spawned inside it (incl. hooks)', async () => {
  const dir = h.initRepo();
  const ac = new AbortController();
  const p = x.withSignal(ac.signal, () => x.run(dir, ['-c', 'alias.slow=!sleep 5', 'slow']));
  setTimeout(() => ac.abort(), 100);
  await assert.rejects(p, (e) => e.kind === 'aborted');
  // outside the context nothing is attached
  await x.run(dir, ['status']);
});

test('core.fsmonitor from repo config is never executed', async () => {
  const dir = h.initRepo();
  const marker = path.join(h.tmpDir(), 'ran');
  h.git(dir, 'config', 'core.fsmonitor', `touch ${marker}; false`);
  await x.out(dir, ['status', '--porcelain']);
  assert.equal(fs.existsSync(marker), false);
});

test('an ext:: remote never runs, even when repo config allows the protocol or a url.insteadOf rewrites to it', async () => {
  const dir = h.initRepo();
  const marker = path.join(h.tmpDir(), 'ran');
  h.git(dir, 'config', 'protocol.ext.allow', 'always');
  h.git(dir, 'config', 'protocol.allow', 'always');
  h.git(dir, 'remote', 'add', 'evil', `ext::sh -c touch% ${marker}`);
  h.git(dir, 'config', `url.ext::sh -c touch% ${marker}.insteadOf`, 'https://example.invalid/');
  await assert.rejects(x.run(dir, ['fetch', 'evil']), /transport 'ext' not allowed/);
  await assert.rejects(x.run(dir, ['fetch', 'https://example.invalid/r.git']), /transport 'ext' not allowed/);
  assert.equal(fs.existsSync(marker), false);
  // What the override prevents: a plain git there runs the command.
  if (process.platform !== 'win32') {
    assert.throws(() => h.git(dir, 'fetch', 'evil'), 'the command speaks no git protocol');
    assert.equal(fs.existsSync(marker), true, 'the attack is real');
  }
});

test('setGitBinary switches the executable used for every command', { skip: process.platform === 'win32' && 'the fake git is a #!/bin/sh script, which Windows cannot spawn' }, async (t) => {
  const dir = h.initRepo();
  const bin = path.join(h.tmpDir(), 'fake-git');
  fs.writeFileSync(bin, '#!/bin/sh\necho fake\n', { mode: 0o755 });
  t.after(() => x.setGitBinary(null));
  await x.resolveRoot(dir); // cache the real root first; the fake binary can't answer rev-parse
  x.setGitBinary(bin);
  assert.equal((await x.out(dir, ['status'])).trim(), 'fake');
  x.setGitBinary(null);
  assert.match(await x.out(dir, ['--version']), /^git version /);
  assert.throws(() => x.setGitBinary('git'), /absolute/, 'a bare name is refused');
  assert.throws(() => x.setGitBinary('./bin/git'), /absolute/);
});

test('the default git comes from PATH as an absolute path: a git planted in the repo never runs', async (t) => {
  const dir = h.initRepo();
  await x.resolveRoot(dir);
  const marker = path.join(h.tmpDir(), 'planted-ran');
  for (const name of ['git', 'git.exe']) fs.writeFileSync(path.join(dir, name), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  const savedPath = process.env.PATH;
  t.after(() => { process.env.PATH = savedPath; x.setGitBinary(null); });
  // Empty and '.' entries mean cwd (the repo) to a plain exec lookup; they are skipped.
  process.env.PATH = `.::${savedPath}`;
  x.setGitBinary(null);
  assert.match(await x.out(dir, ['--version']), /^git version /);
  assert.equal(fs.existsSync(marker), false);
  // No git on PATH at all: ENOENT, never a bare-name spawn.
  process.env.PATH = '.';
  x.setGitBinary(null);
  await assert.rejects(x.run(dir, ['status']), (e) => e.code === 'ENOENT' && /not found on PATH/.test(e.message));
  assert.equal(fs.existsSync(marker), false);
});

test('resolveRoot: a subdirectory that becomes its own repo resolves to itself', async () => {
  const outer = h.initRepo();
  const sub = path.join(outer, 'sub');
  fs.mkdirSync(sub);
  assert.equal(await x.resolveRoot(sub), outer);
  assert.equal(await x.resolveRoot(outer), outer);
  h.git(sub, 'init', '-q');
  assert.equal(await x.resolveRoot(sub), sub);
  assert.equal(await x.resolveRoot(outer), outer);
});

test('resolveRoot keeps a bare repo and a .git folder as they are', async () => {
  const bare = h.initRepo({ bare: true });
  assert.equal(await x.resolveRoot(bare), bare);
  const dir = h.initRepo();
  assert.equal(await x.resolveRoot(path.join(dir, '.git')), path.join(dir, '.git'));
});

test('maxBytes: output beyond the cap kills git and rejects with kind too-large', async () => {
  const dir = h.initRepo();
  h.write(dir, 'big.txt', 'x'.repeat(200000));
  const sha = (await x.out(dir, ['hash-object', '-w', '--', 'big.txt'])).trim();
  await assert.rejects(
    x.run(dir, ['cat-file', 'blob', sha], { maxBytes: 1000 }),
    (e) => e instanceof x.GitError && e.kind === 'too-large' && /exceeded 1000 bytes/.test(e.message),
  );
  // tryOut does not turn it into "git failed" (null).
  await assert.rejects(x.tryOut(dir, ['cat-file', 'blob', sha], { maxBytes: 1000 }), { kind: 'too-large' });
  assert.equal((await x.out(dir, ['cat-file', 'blob', sha])).length, 200000);
  assert.equal(x.MAX_OUTPUT_BYTES, 256 * 1024 * 1024);
});

test('a failure while building the result rejects instead of hanging', async () => {
  const dir = h.initRepo();
  // An unknown encoding makes toString throw inside the close handler (as ERR_STRING_TOO_LONG would).
  await assert.rejects(x.run(dir, ['status'], { encoding: 'no-such-encoding' }), /encoding/i);
});

test('an already aborted signal rejects without spawning git', async (t) => {
  const dir = h.initRepo();
  await x.resolveRoot(dir);
  const bin = path.join(h.tmpDir(), 'marker-git');
  const marker = path.join(h.tmpDir(), 'ran');
  fs.writeFileSync(bin, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  t.after(() => x.setGitBinary(null));
  x.setGitBinary(bin);
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(x.run(dir, ['status'], { signal: ac.signal }), (e) => e instanceof x.GitError && e.kind === 'aborted');
  assert.equal(fs.existsSync(marker), false);
});

/** Minimal AbortSignal stand-in that counts its listeners. */
function countingSignal() {
  const s = { aborted: false, listeners: 0 };
  s.addEventListener = () => { s.listeners++; };
  s.removeEventListener = () => { s.listeners--; };
  return s;
}

test('spawn errors: a missing git binary rejects with ENOENT and releases the abort listener', async (t) => {
  const dir = h.initRepo();
  await x.resolveRoot(dir);
  t.after(() => x.setGitBinary(null));
  x.setGitBinary(path.join(h.tmpDir(), 'no-such-git'));
  const signal = countingSignal();
  await assert.rejects(x.run(dir, ['status'], { signal }), (e) => !(e instanceof x.GitError) && e.code === 'ENOENT');
  assert.equal(signal.listeners, 0);
  // tryOut propagates it (git missing is not "git said no").
  await assert.rejects(x.tryOut(dir, ['status']), { code: 'ENOENT' });
});

test('spawn errors: a missing working folder rejects with ENOENT', async () => {
  const gone = path.join(h.tmpDir(), 'gone');
  const signal = countingSignal();
  await assert.rejects(x.run(gone, ['status'], { signal }), (e) => !(e instanceof x.GitError) && e.code === 'ENOENT');
  assert.equal(signal.listeners, 0);
  await assert.rejects(x.headState(gone), { code: 'ENOENT' });
});

test('GIT_TRACE from the environment does not reach git (it would pollute stderr)', async (t) => {
  const dir = h.initRepo();
  t.after(() => { delete process.env.GIT_TRACE; delete process.env.GIT_TRACE_PERFORMANCE; });
  process.env.GIT_TRACE = '1';
  process.env.GIT_TRACE_PERFORMANCE = '2';
  const { stderr } = await x.run(dir, ['status', '--porcelain']);
  assert.equal(stderr, '');
});

test('killChildren: only cancelled commands by default (SIGKILL for one that ignored SIGTERM); all: every one', { skip: process.platform === 'win32' && 'POSIX signals: trap TERM and pgrep (Windows kills with taskkill /F, which nothing ignores)' }, async () => {
  const dir = h.initRepo();
  const tag = `pl-kill-${process.pid}-${Date.now()}`;
  const alive = () => require('node:child_process').spawnSync('pgrep', ['-f', tag]).status === 0;
  const waitFor = async (want) => {
    const t0 = Date.now();
    while (alive() !== want) {
      assert.ok(Date.now() - t0 < 5000, `sleep never became ${want ? 'alive' : 'gone'}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  // A cancelled command whose process group ignores SIGTERM stays alive until killChildren().
  // The marker is written after `trap`, so the abort can't land before SIGTERM is ignored (the
  // shell is visible to pgrep before it has run the trap, which raced under a loaded machine).
  const marker = path.join(dir, '.git', `${tag}.trapped`);
  const ac = new AbortController();
  const stubborn = x.run(dir, ['-c', `alias.slow=!trap '' TERM; : > '${marker}'; sleep 30; : ${tag}`, 'slow'], { signal: ac.signal });
  await waitFor(true);
  for (const t0 = Date.now(); !fs.existsSync(marker); await new Promise((r) => setTimeout(r, 20))) {
    assert.ok(Date.now() - t0 < 5000, 'the trap was never installed');
  }
  ac.abort();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(alive(), true, 'SIGTERM is ignored');
  assert.equal(x.killChildren(), 1);
  await assert.rejects(stubborn, (e) => e.kind === 'aborted');
  await waitFor(false);
  // A command with no signal (an uncancellable phase) is left alone unless `all`.
  const plain = x.run(dir, ['-c', `alias.slow=!sleep 30; : ${tag}`, 'slow']);
  await waitFor(true);
  assert.equal(x.killChildren(), 0);
  assert.equal(alive(), true);
  assert.equal(x.killChildren({ all: true, signal: 'SIGTERM' }), 1);
  await assert.rejects(plain, (e) => e.kind === 'aborted');
  await waitFor(false);
  assert.equal(x.killChildren({ all: true }), 0); // nothing left
});

test('signalGroup on Windows: taskkill /T /F of the tree from System32 (hidden), the MSYS processes by token, git itself only when taskkill fails', () => {
  const { signalGroup, MSYS_KILL, KILL_TOKEN_VAR } = require('../src/git-process')._internal;
  const child = (o = {}) => {
    const c = { pid: 4242, exitCode: null, signalCode: null, kills: [], ...o };
    c.kill = (sig) => { c.kills.push(sig); return true; };
    return c;
  };
  const runs = [];
  const run = (outcome) => (file, args, opts, cb) => {
    runs.push({ file, args, opts });
    if (outcome === 'throw') throw new Error('spawn EPERM');
    cb(outcome === 'fail' ? Object.assign(new Error('exit 128'), { code: 128 }) : null);
  };
  const logged = [];
  const logTo = { log: (level, msg, fields) => logged.push({ level, msg, ...fields }) };
  const win = { platform: 'win32', env: { SystemRoot: 'D:\\Win' }, logTo };
  const ok = child();
  signalGroup(ok, 'SIGTERM', { ...win, run: run('ok') });
  assert.equal(runs.length, 1, 'no token / sh: taskkill only');
  assert.deepEqual(runs[0].file, 'D:\\Win\\System32\\taskkill.exe');
  assert.deepEqual(runs[0].args, ['/PID', '4242', '/T', '/F']);
  assert.equal(runs[0].opts.windowsHide, true);
  assert.equal(runs[0].opts.detached, true, 'outlives an app exiting right after');
  assert.deepEqual(ok.kills, []);
  // With the command's token and Git for Windows' sh: its MSYS processes too, by the token (an
  // argument: the sh doesn't carry it), hidden, not detached (its grep would open a console).
  runs.length = 0;
  const sh = 'C:\\Git\\usr\\bin\\sh.exe';
  signalGroup(child(), 'SIGTERM', { ...win, run: run('ok'), token: 'abc123', sh });
  assert.deepEqual(runs.map((r) => r.file), ['D:\\Win\\System32\\taskkill.exe', sh]);
  assert.deepEqual(runs[1].args, ['-c', MSYS_KILL, 'sh', `${KILL_TOKEN_VAR}=abc123`]);
  assert.equal(runs[1].opts.windowsHide, true);
  assert.equal(runs[1].opts.detached, undefined);
  assert.equal(runs[1].opts.env, undefined, 'the app\'s env, which has no token');
  assert.deepEqual(logged, [{ level: 'debug', msg: 'killed the MSYS processes of a git', pid: 4242, killed: 0 }]);
  logged.length = 0;
  // taskkill failed (git already gone) or couldn't start: git itself is killed.
  const failed = child();
  signalGroup(failed, 'SIGKILL', { ...win, run: run('fail') });
  assert.deepEqual(failed.kills, ['SIGKILL']);
  const thrown = child();
  signalGroup(thrown, 'SIGTERM', { ...win, run: run('throw') });
  assert.deepEqual(thrown.kills, ['SIGTERM']);
  // Both failures are logged, not swallowed: a warning while git still runs (its tree may too).
  assert.deepEqual(logged, [
    { level: 'warn', msg: 'taskkill failed', pid: 4242, error: 128 },
    { level: 'warn', msg: 'taskkill failed', pid: 4242, error: 'spawn EPERM' },
  ]);
  // git exited while taskkill started (the race the exit check can't close): only a debug record.
  logged.length = 0;
  const raced = child();
  signalGroup(raced, 'SIGKILL', {
    ...win,
    run: (file, args, opts, cb) => { raced.exitCode = 0; cb(Object.assign(new Error('exit 128'), { code: 128 })); },
  });
  assert.deepEqual(logged.map((r) => r.level), ['debug']);
  assert.deepEqual(raced.kills, ['SIGKILL'], "through Node's handle: a no-op once git is gone");
  // An exited git's pid may already be another process's: no taskkill. Its MSYS processes are
  // still killed, by the token: a hook's background job holding git's output keeps the command
  // from settling after git itself is gone.
  runs.length = 0;
  const exitedGit = child({ exitCode: 1 });
  signalGroup(exitedGit, 'SIGKILL', { ...win, run: run('ok'), token: 't', sh });
  signalGroup(child({ signalCode: 'SIGTERM' }), 'SIGKILL', { ...win, run: run('ok'), token: 't', sh });
  assert.deepEqual(runs.map((r) => r.file), [sh, sh]);
  assert.deepEqual(exitedGit.kills, [], 'not through the handle either');
  runs.length = 0;
  signalGroup(child({ exitCode: 0 }), 'SIGKILL', { ...win, run: run('ok') }); // no token / sh
  signalGroup(child({ pid: undefined }), 'SIGKILL', { ...win, run: run('ok'), token: 't', sh }); // never started
  assert.equal(runs.length, 0);
  // The MSYS kill reports how many it ended (debug), and a failure with the script's reason.
  logged.length = 0;
  const reply = (err, stdout, stderr) => (file, args, opts, cb) => cb(err, stdout, stderr);
  signalGroup(child({ exitCode: 0 }), 'SIGKILL', { ...win, run: reply(null, '2\n', ''), token: 't', sh });
  signalGroup(child({ exitCode: 0 }), 'SIGKILL', { ...win, run: reply(Object.assign(new Error('exit 3'), { code: 3 }), '', 'no /usr/bin/grep\n'), token: 't', sh });
  assert.deepEqual(logged, [
    { level: 'debug', msg: 'killed the MSYS processes of a git', pid: 4242, killed: 2 },
    { level: 'warn', msg: 'killing the MSYS processes failed', pid: 4242, error: 3, detail: 'no /usr/bin/grep' },
  ]);
  // Never a bare or relative taskkill (looked up in the repo folder first): which.system32.
  signalGroup(child(), 'SIGKILL', { ...win, env: { SystemRoot: '.\\evil' }, run: run('ok') });
  assert.equal(runs[0].file, 'C:\\Windows\\System32\\taskkill.exe');
  // Elsewhere: the process group; a group that is gone falls back to the child.
  runs.length = 0;
  const posix = child({ pid: 2 ** 30 });
  signalGroup(posix, 'SIGTERM', { platform: 'linux', run: run('ok'), token: 't', sh });
  assert.deepEqual(posix.kills, ['SIGTERM']);
  assert.equal(runs.length, 0);
});

test('msysShell: Git for Windows\' usr\\bin\\sh.exe from git.exe in any of its folders or behind a Scoop shim; none for MinGit', () => {
  const { msysShell } = require('../src/git-process')._internal;
  const have = new Set(['C:\\Program Files\\Git\\usr\\bin\\sh.exe', 'C:\\Users\\u\\scoop\\apps\\git\\current\\usr\\bin\\sh.exe']);
  const isFile = (p) => have.has(p);
  const shims = {
    'C:\\Users\\u\\scoop\\shims\\git.shim': 'path = "C:\\Users\\u\\scoop\\apps\\git\\current\\mingw64\\bin\\git.exe"\r\nargs =\r\n',
    'C:\\old\\shims\\git.shim': 'path = C:\\Users\\u\\scoop\\apps\\git\\current\\bin\\git.exe\n', // older Scoop: no quotes
    'C:\\bad\\shims\\git.shim': 'path = ..\\Program Files\\Git\\cmd\\git.exe\n', // never a relative target
  };
  const readFile = (p) => {
    if (p in shims) return shims[p];
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };
  const o = { isFile, readFile };
  for (const git of ['cmd', 'bin', 'mingw64\\bin', 'mingw64\\libexec\\git-core', 'MINGW32\\bin', 'clangarm64\\libexec\\git-core']) {
    assert.equal(msysShell(`C:\\Program Files\\Git\\${git}\\git.exe`, o), 'C:\\Program Files\\Git\\usr\\bin\\sh.exe', git);
  }
  assert.equal(msysShell('C:\\Users\\u\\scoop\\shims\\git.exe', o), 'C:\\Users\\u\\scoop\\apps\\git\\current\\usr\\bin\\sh.exe');
  assert.equal(msysShell('C:\\old\\shims\\git.exe', o), 'C:\\Users\\u\\scoop\\apps\\git\\current\\usr\\bin\\sh.exe');
  assert.equal(msysShell('C:\\bad\\shims\\git.exe', o), null);
  assert.equal(msysShell('C:\\MinGit\\cmd\\git.exe', o), null);
  // Never further up than git's own installation.
  assert.equal(msysShell('C:\\Program Files\\Git\\a\\b\\c\\git.exe', o), null);
  assert.equal(msysShell('C:\\Program Files\\Git\\mingw64\\x\\bin\\git.exe', o), null);
});

test('writesIndex: only the commands that take the index lock, found after git\'s own options', () => {
  const { GLOBAL_ARGS, _internal: { writesIndex } } = require('../src/git-process');
  for (const args of [
    ['commit', '-q', '-a'], ['-c', 'core.hooksPath=x', 'merge', '--no-ff'], ['stash', 'push'], ['apply', '--cached', '-'],
    ['apply', '-q', '--index'], ['update-index', '-z', '--index-info'], ['-C', 'sub', 'rm', '--cached', 'x'],
    ['--git-dir', 'x', 'add', '.'], ['--no-pager', 'rebase', '--continue'], ['write-tree'], ['restore', '--staged', 'x'],
  ]) assert.equal(writesIndex([...GLOBAL_ARGS, ...args]), true, args.join(' '));
  for (const args of [
    ['fetch', 'origin'], ['status', '-z'], ['diff', '--cached'], ['log', 'commit'], ['apply', '--check', '-'], ['clean', '-f'],
    ['ls-files', '-z'], ['-c', 'commit'], ['merge-base', 'a', 'b'], ['--version'], [],
  ]) assert.equal(writesIndex([...GLOBAL_ARGS, ...args]), false, args.join(' '));
});

test('watchIndexLock: on Windows, the index.lock of a writing command started at a worktree root (its own index for a linked worktree, GIT_INDEX_FILE\'s)', () => {
  const { watchIndexLock, indexLockPath } = require('../src/git-process')._internal;
  const dir = h.initRepo();
  const real = (p) => path.join(fs.realpathSync(path.dirname(p)), path.basename(p));
  assert.equal(watchIndexLock(['commit'], dir, undefined, 'linux'), null, 'POSIX: git removes its locks itself');
  assert.equal(watchIndexLock(['fetch'], dir, undefined, 'win32'), null, 'a read: never');
  assert.deepEqual(watchIndexLock(['commit'], dir, undefined, 'win32'), { path: path.join(dir, '.git', 'index.lock'), before: null, killedAt: null, atKill: null });
  assert.equal(indexLockPath(dir, { GIT_INDEX_FILE: 'tmp/idx' }), path.join(dir, 'tmp', 'idx.lock'));
  // Not a worktree root (a subfolder, no repo): not known, nothing will be released.
  fs.mkdirSync(path.join(dir, 'sub'));
  assert.equal(indexLockPath(path.join(dir, 'sub')), null);
  assert.equal(indexLockPath(h.tmpDir()), null);
  // A linked worktree: the .git file names its git dir, whose index is its own (what rev-parse says).
  const wt = path.join(h.tmpDir(), 'wt');
  h.git(dir, 'worktree', 'add', '-q', wt);
  const want = path.resolve(wt, h.git(wt, 'rev-parse', '--git-path', 'index').trim());
  assert.equal(real(indexLockPath(wt)), real(`${want}.lock`));
});

test('releaseKilledLock: removes only the index.lock there at the kill, still the same file, not there at the start, with no other git of ours there', async (t) => {
  const { releaseKilledLock, watchIndexLock, noteKill, fileIdentity } = require('../src/git-process')._internal;
  const dir = h.initRepo();
  const lock = path.join(dir, '.git', 'index.lock');
  const since = Date.now() - 1000;
  const running = { exitCode: null, signalCode: null };
  const watched = () => watchIndexLock(['commit', '-q'], dir, undefined, 'win32');
  // mtimes set explicitly: a file system's may be coarser than the steps of this test.
  const touch = (at = Date.now()) => {
    fs.writeFileSync(lock, '');
    fs.utimesSync(lock, new Date(at), new Date(at));
  };
  // Another file in its place, created before the old one goes (so it can't reuse its inode).
  const replace = () => {
    fs.writeFileSync(`${lock}.new`, '');
    fs.renameSync(`${lock}.new`, lock);
  };
  const release = (w, env) => releaseKilledLock(dir, env, since, w);
  t.after(() => fs.rmSync(lock, { recursive: true, force: true }));

  // The lock our git took and left when it was killed.
  let w = watched();
  touch();
  noteKill(w, running);
  assert.equal(await release(w), 'removed');
  assert.equal(fs.existsSync(lock), false);
  // None there at the kill: one created after it is another program's.
  w = watched();
  noteKill(w, running);
  touch();
  assert.equal(await release(w), 'none');
  assert.equal(fs.existsSync(lock), true);
  // Already there when the command started: another git's (ours could not take it).
  w = watched();
  touch();
  noteKill(w, running);
  assert.notEqual(w.before, null);
  assert.equal(await release(w), 'kept');
  // ... unless it went away and the one at the kill is a new file: ours.
  w = watched();
  replace();
  noteKill(w, running);
  assert.equal(await release(w), 'removed');
  // Replaced between the kill and the release (removed, then taken by another git): kept.
  w = watched();
  touch();
  noteKill(w, running);
  replace();
  assert.equal(await release(w), 'kept');
  fs.rmSync(lock);
  // Last written before the command started: not ours.
  w = watched();
  touch(since - 60000);
  noteKill(w, running);
  assert.equal(await release(w), 'kept');
  fs.rmSync(lock);
  // git had exited on its own before the kill (a hook's background job held its output): it
  // removed its own lock, so whatever is there is not ours; nothing is even looked at.
  w = watched();
  touch();
  noteKill(w, { exitCode: 0, signalCode: null });
  assert.equal(w.killedAt, null);
  assert.equal(await release(w), 'none');
  assert.equal(fs.existsSync(lock), true);
  fs.rmSync(lock);
  // A folder there (or a link): never removed, never followed.
  w = watched();
  fs.mkdirSync(lock);
  noteKill(w, running);
  assert.equal(await release(w), 'kept');
  fs.rmdirSync(lock);
  if (process.platform !== 'win32') { // creating a symlink needs a privilege on Windows
    const target = path.join(h.tmpDir(), 'target');
    fs.writeFileSync(target, 'keep');
    w = watched();
    fs.symlinkSync(target, lock);
    noteKill(w, running);
    assert.equal(await release(w), 'kept');
    assert.equal(fs.readFileSync(target, 'utf8'), 'keep');
    fs.unlinkSync(lock);
  }
  // Another git of ours, started in that folder before the kill, may hold it.
  w = watched();
  touch();
  noteKill(w, running);
  await new Promise((r) => setTimeout(r, 20)); // its start is a later millisecond
  const ac = new AbortController();
  const slow = x.run(dir, ['-c', 'alias.slow=!sleep 5', 'slow'], { signal: ac.signal });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await releaseKilledLock(path.join(dir, '.'), undefined, since, w), 'removed', 'it started after the kill');
  touch();
  w.killedAt = Date.now();
  w.atKill = fileIdentity(lock);
  assert.equal(await releaseKilledLock(path.join(dir, '.'), undefined, since, w), 'busy');
  assert.equal(fs.existsSync(lock), true);
  ac.abort();
  await assert.rejects(slow, (e) => e.kind === 'aborted');
  assert.equal(await release(w), 'removed');
  // The index the command used: a GIT_INDEX_FILE of its env; a path git doesn't name is kept.
  const tmpIndex = path.join(h.tmpDir(), 'index');
  const env = { GIT_INDEX_FILE: tmpIndex };
  w = watchIndexLock(['update-index'], dir, env, 'win32');
  fs.writeFileSync(`${tmpIndex}.lock`, '');
  noteKill(w, running);
  touch();
  assert.equal(await release(w, undefined), 'kept', 'not the index rev-parse names for that env');
  assert.equal(await release(w, env), 'removed');
  assert.equal(fs.existsSync(`${tmpIndex}.lock`), false);
  assert.equal(fs.existsSync(lock), true, 'the repo\'s own lock is not the one watched');
  // Not a repo: nothing to do, never a throw.
  const notRepo = h.tmpDir();
  fs.writeFileSync(path.join(notRepo, 'index.lock'), '');
  w = { path: path.join(notRepo, 'index.lock'), before: null, killedAt: null, atKill: null };
  noteKill(w, running);
  assert.equal(await releaseKilledLock(notRepo, undefined, since, w), 'failed');
});

test('execFileNow: execFile\'s callback form, finished (callback included) before it returns', () => {
  const { execFileNow } = require('../src/git-process')._internal;
  const got = [];
  execFileNow(process.execPath, ['-e', 'process.stdout.write("2\\n")'], { windowsHide: true }, (err, stdout) => got.push({ err, stdout }));
  assert.deepEqual(got, [{ err: null, stdout: '2\n' }]);
  execFileNow(process.execPath, ['-e', 'process.stderr.write("no grep\\n"); process.exit(3)'], {}, (err, stdout, stderr) => got.push({ code: err.code, stderr }));
  assert.deepEqual(got[1], { code: 3, stderr: 'no grep\n' }, 'the exit code as `code`, as execFile has it');
});

test('argvChunks: every Windows command line fits CreateProcess (32,767 UTF-16 units, quoting and the fixed args counted)', () => {
  const { argvChunks, GLOBAL_ARGS, DIFF_ARGS, _internal: { winArgLength, WIN_CMDLINE_MAX, WIN_EXE_RESERVE } } = require('../src/git-process');
  // libuv's quote_cmd_arg (what Node does to each argument on Windows), for reference.
  const quoted = (a) => {
    if (a === '') return '""';
    if (!/[ \t"]/.test(a)) return a;
    if (!/["\\]/.test(a)) return `"${a}"`;
    let out = '';
    let quoteHit = true;
    for (let i = a.length - 1; i >= 0; i--) {
      out = a[i] + out;
      if (quoteHit && a[i] === '\\') out = `\\${out}`;
      else if (a[i] === '"') { quoteHit = true; out = `\\${out}`; } else quoteHit = false;
    }
    return `"${out}"`;
  };
  for (const a of ['', 'a', 'a b', 'a"b', 'C:\\x y\\', 'x\\\\"y', '\\"', 'tab\there', 'dir\\file.txt', '\u{1F600} smile']) {
    assert.ok(winArgLength(a) >= quoted(a).length + 1, `${JSON.stringify(a)}: ${winArgLength(a)} < ${quoted(a).length + 1}`);
  }
  assert.equal(winArgLength('plain/path.txt'), 'plain/path.txt'.length + 1, 'an unquoted path costs its length and a space');
  assert.equal(winArgLength('\u{1F600}'), 3, 'UTF-16 code units, not characters');

  // undo.test's "discard of 3000 paths": over 32K on one command line (ENAMETOOLONG on Windows).
  const paths = Array.from({ length: 3000 }, (_, i) => `many/some-longish-directory-name/file-${i}.txt`);
  const prefix = ['clean', '-f', '-q', '--'];
  const win = argvChunks(paths, { prefix, platform: 'win32' });
  assert.deepEqual(win.flat(), paths, 'every path once, in order');
  for (const chunk of win) {
    const line = WIN_EXE_RESERVE + [...GLOBAL_ARGS, ...DIFF_ARGS, ...prefix, ...chunk].reduce((n, a) => n + winArgLength(a), 0);
    assert.ok(line <= WIN_CMDLINE_MAX, `${line} > ${WIN_CMDLINE_MAX}`);
  }
  assert.ok(win.length > 3, 'smaller chunks than the 1000-path cap');
  // Names that need quoting cost more; a longer prefix leaves less room.
  const spaced = paths.map((p) => p.replace('longish', 'long "ish"'));
  assert.ok(argvChunks(spaced, { prefix, platform: 'win32' }).length > win.length);
  assert.ok(argvChunks(paths, { prefix: [...prefix, 'x'.repeat(10000)], platform: 'win32' }).length > win.length);
  // Elsewhere only the count and byte caps apply, as before.
  assert.deepEqual(argvChunks(paths, { prefix, platform: 'linux' }).map((c) => c.length), [1000, 1000, 1000]);
  assert.deepEqual(argvChunks(['a', 'b'], { platform: 'win32' }), [['a', 'b']]);
  assert.deepEqual(argvChunks([], { platform: 'win32' }), []);
});

test('lsUntracked: many paths go to ls-files in argv chunks (Windows command line), each file once; cleanFiles removes them', async () => {
  const { argvChunks } = require('../src/git-process');
  const d = h.initRepo();
  const dirs = [];
  for (let i = 0; i < 160; i++) {
    const dir = `${String(i).padStart(3, '0')}-${'d'.repeat(200)}`;
    h.write(d, `${dir}/u.txt`, 'x\n');
    dirs.push(dir);
  }
  h.write(d, `${dirs[0]}/ignored.log`, 'x\n');
  h.write(d, '.gitignore', '*.log\n');
  // Pathspecs are literal: '*' is this file, not every file (a name Windows forbids).
  if (process.platform !== 'win32') h.write(d, '*', 'a literal star\n');
  dirs.push(`${dirs[0]}/`); // also listed by another chunk: counted once
  assert.ok(argvChunks(dirs, { prefix: ['ls-files', '-z', '--others', '--exclude-standard', '--'], platform: 'win32' }).length > 1, 'more than one command line on Windows');
  const want = dirs.slice(0, 160).map((dir) => `${dir}/u.txt`).sort();
  // Off Windows also as on Windows; there only (a single POSIX-sized chunk is ENAMETOOLONG).
  for (const platform of process.platform === 'win32' ? ['win32'] : ['win32', 'linux']) {
    assert.deepEqual([...await x.lsUntracked(d, dirs, { platform })].sort(), want, platform);
  }
  assert.deepEqual([...await x.lsUntracked(d, [])], []);
  if (process.platform !== 'win32') assert.deepEqual([...await x.lsUntracked(d, ['*'])], ['*']);
  // From a subdirectory: still root-relative paths.
  assert.deepEqual([...await x.lsUntracked(path.join(d, dirs[1]), [`${dirs[1]}/u.txt`])], [`${dirs[1]}/u.txt`]);
  await x.cleanFiles(d, want.slice(0, 150), { platform: 'win32' });
  assert.deepEqual([...await x.lsUntracked(d, dirs)].sort(), want.slice(150));
  assert.equal(fs.existsSync(path.join(d, dirs[0], 'ignored.log')), true);
});

test('cancelling on Windows ends git, its hook and the MSYS commands the hook started (not through the Windows tree), and nothing else', { skip: process.platform !== 'win32' && 'Windows: taskkill and the MSYS processes of Git for Windows' }, async (t) => {
  const { spawn, execFileSync } = require('node:child_process');
  const { findOnPath, system32 } = require('../src/which');
  const { msysShell } = require('../src/git-process')._internal;
  const sh = msysShell(findOnPath('git.exe'));
  assert.ok(sh, 'Git for Windows\' sh next to the git on PATH');
  const taskkill = (pid) => { try { execFileSync(path.join(system32(), 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } };
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  // A bystander: an MSYS sleep of our own, outside git's tree. It must survive the cancel.
  const bystander = spawn(sh, ['-c', 'exec /usr/bin/sleep 60'], { windowsHide: true, stdio: 'ignore' });
  t.after(() => taskkill(bystander.pid));
  const dir = h.initRepo();
  const before = h.git(dir, 'rev-parse', 'HEAD');
  h.write(dir, 'README.md', 'changed\n');
  // `commit -a` holds index.lock across pre-commit. The hook writes its own Windows pid and its
  // two sleeps' (MSYS /proc/<pid>/winpid): forked commands, whose Windows parent (the forked sh)
  // exits at once, so taskkill /T can't find them. Right after `&`, $! may still be the forked
  // sh (its winpid not yet sleep's): the hook waits, bounded, until both run sleep.
  const pids = path.join(dir, '.git', 'pids').replace(/\\/g, '/');
  fs.writeFileSync(path.join(dir, '.git', 'hooks', 'pre-commit'), [
    '#!/bin/sh',
    'sleep 60 & a=$!',
    'sleep 61 & b=$!',
    'n=0',
    'while [ $n -lt 100 ]; do',
    '  case "$(cat /proc/$a/exename /proc/$b/exename 2>/dev/null)" in */sleep*/sleep*) break ;; esac',
    '  n=$((n+1)); sleep 0.1',
    'done',
    `echo $(cat /proc/$$/winpid) $(cat /proc/$a/winpid) $(cat /proc/$b/winpid) > '${pids}.tmp' && mv '${pids}.tmp' '${pids}'`,
    'wait',
    '',
  ].join('\n'));
  const ac = new AbortController();
  let hook = [];
  // A failed assertion before the cancel must not leave the commit and its sleeps running.
  t.after(() => {
    ac.abort();
    for (const pid of hook) taskkill(pid);
  });
  const p = x.run(dir, ['commit', '-q', '-a', '-m', 'x'], { signal: ac.signal });
  for (const t0 = Date.now(); !fs.existsSync(pids); await new Promise((r) => setTimeout(r, 50))) {
    assert.ok(Date.now() - t0 < 60000, 'the hook never started');
  }
  hook = fs.readFileSync(pids, 'utf8').trim().split(/\s+/).map(Number);
  assert.equal(hook.length, 3);
  assert.ok(hook.every(alive), 'the hook and its sleeps run');
  assert.ok(fs.existsSync(path.join(dir, '.git', 'index.lock')), 'git holds the index lock across the hook');
  const cancelledAt = Date.now();
  ac.abort();
  await assert.rejects(p, (e) => e.kind === 'aborted');
  assert.ok(Date.now() - cancelledAt < 10000, 'settled once its processes were killed, not when the sleeps ended');
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(hook.filter(alive), [], 'the hook and both sleeps are gone');
  assert.equal(bystander.exitCode, null, 'the bystander still runs');
  // git was gone before its hook's commands were killed: it never went on to commit.
  assert.equal(h.git(dir, 'rev-parse', 'HEAD'), before);
  // The lock the hard kill left was ours: removed, so the next write works.
  assert.equal(fs.existsSync(path.join(dir, '.git', 'index.lock')), false);
  fs.rmSync(path.join(dir, '.git', 'hooks', 'pre-commit'));
  await x.run(dir, ['commit', '-q', '-a', '-m', 'after the cancel']);
});

test('cancelling on Windows: a command that doesn\'t write the index leaves another program\'s index.lock alone', { skip: process.platform !== 'win32' && 'Windows: the lock a hard kill leaves' }, async () => {
  const dir = h.initRepo();
  const lock = path.join(dir, '.git', 'index.lock');
  const ac = new AbortController();
  const p = x.run(dir, ['-c', 'alias.slow=!sleep 30', 'slow'], { signal: ac.signal });
  await new Promise((r) => setTimeout(r, 500));
  fs.writeFileSync(lock, ''); // a terminal's `git commit`, in its pre-commit hook
  ac.abort();
  await assert.rejects(p, (e) => e.kind === 'aborted');
  assert.equal(fs.existsSync(lock), true);
  fs.rmSync(lock);
});

test('cancelling on Windows after git exited on its own (a hook\'s background job holds its output): the job is ended, no lock is touched', { skip: process.platform !== 'win32' && 'Windows: the MSYS processes of Git for Windows' }, async (t) => {
  const { execFileSync } = require('node:child_process');
  const { system32 } = require('../src/which');
  const taskkill = (pid) => { try { execFileSync(path.join(system32(), 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } };
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const dir = h.initRepo();
  const before = h.git(dir, 'rev-parse', 'HEAD');
  h.write(dir, 'README.md', 'changed\n');
  // The hook returns at once, leaving a sleep behind on git's stderr: git commits and exits, but
  // the command doesn't settle while the sleep holds the pipe.
  const pidFile = path.join(dir, '.git', 'bg').replace(/\\/g, '/');
  fs.writeFileSync(path.join(dir, '.git', 'hooks', 'post-commit'), [
    '#!/bin/sh',
    'sleep 60 & a=$!',
    'n=0',
    'while [ $n -lt 100 ]; do case "$(cat /proc/$a/exename 2>/dev/null)" in */sleep*) break ;; esac; n=$((n+1)); sleep 0.1; done',
    `cat /proc/$a/winpid > '${pidFile}.tmp' && mv '${pidFile}.tmp' '${pidFile}'`,
    '',
  ].join('\n'));
  const ac = new AbortController();
  let bg = null;
  t.after(() => {
    ac.abort();
    if (bg) taskkill(bg);
  });
  let settled = false;
  const p = x.run(dir, ['commit', '-q', '-a', '-m', 'x'], { signal: ac.signal });
  p.then(() => { settled = true; }, () => { settled = true; });
  for (const t0 = Date.now(); !fs.existsSync(pidFile); await new Promise((r) => setTimeout(r, 50))) {
    assert.ok(Date.now() - t0 < 60000, 'the hook never ran');
  }
  bg = Number(fs.readFileSync(pidFile, 'utf8').trim());
  assert.ok(alive(bg));
  await new Promise((r) => setTimeout(r, 1000)); // git is done
  assert.notEqual(h.git(dir, 'rev-parse', 'HEAD'), before, 'git committed');
  assert.equal(settled, false, 'the sleep keeps the command from settling');
  // Another program's git takes the index lock meanwhile: not ours, whatever the cancel does.
  const lock = path.join(dir, '.git', 'index.lock');
  fs.writeFileSync(lock, '');
  const cancelledAt = Date.now();
  ac.abort();
  await assert.rejects(p, (e) => e.kind === 'aborted');
  assert.ok(Date.now() - cancelledAt < 10000, 'settled once the sleep was killed');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(alive(bg), false, 'the background job is gone');
  assert.equal(fs.existsSync(lock), true, 'git had exited on its own: no lock of its is left');
  fs.rmSync(lock);
});
