'use strict';
// cloneRepo (src/clone.js) with real git, against local fixtures only: bare repositories over
// file:// (built with pathToFileURL so Windows paths work) and local paths, which the app never
// passes (it clones remotes only; these tests pass localFixtures), plus local HTTP servers on
// 127.0.0.1 (401, dropped connections, never answering). No test touches the network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const h = require('./helpers');
const { cloneRepo, CLONE_ARGS, _internal: { testHooks, throttle, mkdirError, classified, MAX_CLONE_OUTPUT, FIXTURE_ARGS } } = require('../src/clone');
const { bornOf } = require('../src/clone-cleanup');
const { createCleanup } = require('../src/clone-cleanup');
const { createClonePrefs } = require('../src/recent');
const { killChildren, GitError } = require('../src/exec');
const { gitAt } = require('../src/git-process');
const redact = require('../src/redact');

const fileUrl = (p) => pathToFileURL(p).href;
const posix = process.platform !== 'win32';

/** git with stdin (h.git takes none). */
const gitIn = (cwd, input, ...args) => execFileSync('git', args, { cwd, input, encoding: 'utf8' }).trim();

/** A bare clone of a fresh repository after `setup(seed)`. */
function bareOf(setup) {
  const seed = h.initRepo();
  if (setup) setup(seed);
  const bare = h.tmpDir();
  h.git(bare, 'clone', '-q', '--bare', seed, '.');
  return bare;
}

/** A cleanup over a throwaway clone.json, for removing what a failed clone made. */
const cleanupOf = () => createCleanup({ prefs: createClonePrefs(path.join(h.tmpDir(), 'clone.json')), log: { info() {}, warn() {} } });

async function rejectsWithMade(p, kind) {
  const err = await p.then(() => assert.fail('the clone succeeded'), (e) => e);
  assert.equal(err.kind, kind, `${err.kind}: ${err.message}`);
  assert.ok(err.made, 'err.made is set');
  assert.equal(await cleanupOf().remove(err.made), 'removed');
  assert.equal(fs.existsSync(err.made.abs), false, 'the target is gone afterwards');
  return err;
}

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}/repo.git`, close: () => { server.closeAllConnections(); server.close(); } };
}

test('CLONE_ARGS: the transport allowlist, the file transport never (the tests\' fixtures: FIXTURE_ARGS, "user")', () => {
  assert.deepEqual([...CLONE_ARGS], ['-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'protocol.http.allow=always',
    '-c', 'protocol.ssh.allow=always', '-c', 'protocol.git.allow=always', '-c', 'protocol.file.allow=never']);
  assert.deepEqual(FIXTURE_ARGS.slice(-2), ['-c', 'protocol.file.allow=user']);
  assert.ok(Object.isFrozen(FIXTURE_ARGS));
  assert.ok(Object.isFrozen(CLONE_ARGS));
  assert.equal(MAX_CLONE_OUTPUT, 16 * 1024 * 1024);
});

test('a file:// clone: the files, origin pointing at the source, progress to 100% and done, and what was made', async () => {
  const { remote } = h.repoWithRemote();
  const parent = h.tmpDir();
  const frames = [];
  let made = null;
  const res = await cloneRepo({ source: fileUrl(remote), localFixtures: true, parent, name: 'copy', onProgress: (p) => frames.push(p), onMade: (m) => { made = m; } });
  const root = path.join(parent, 'copy');
  assert.deepEqual(res, { status: 'done', root, name: 'copy', submodules: false, empty: false });
  assert.equal(h.read(root, 'README.md'), 'hello\n');
  assert.equal(h.git(root, 'remote', 'get-url', 'origin').trim(), fileUrl(remote));
  const receiving = frames.filter((f) => f.phase === 'Receiving objects');
  assert.equal(receiving.at(-1).percent, 100);
  assert.equal(receiving.at(-1).done, true, 'a phase\'s done always gets through the throttle');
  const st = fs.lstatSync(root, { bigint: true });
  // The birth time by the code's own rule (bornOf): every file system the app runs on keeps one,
  // and a folder's birth time doesn't move as git writes into it.
  const born = bornOf(st);
  assert.deepEqual(made, { abs: root, dev: String(st.dev), ino: String(st.ino), ...(born ? { born } : {}) });
  if (process.platform === 'darwin' || process.platform === 'win32') assert.match(made.born, /^\d+$/, 'APFS and NTFS keep a birth time');
});

test('a local path (the tests\' fixtures; never the app\'s): the local fast path prints no transfer frames', async () => {
  const { remote } = h.repoWithRemote();
  const parent = h.tmpDir();
  const frames = [];
  const res = await cloneRepo({ source: remote, localFixtures: true, parent, name: 'r', onProgress: (p) => frames.push(p) });
  assert.equal(res.status, 'done');
  assert.equal(frames.filter((f) => f.phase === 'Receiving objects').length, 0);
  assert.equal(h.read(res.root, 'README.md'), 'hello\n');
});

test('an empty bare repository clones as empty (an unborn HEAD)', async () => {
  const bare = h.initRepo({ bare: true });
  const res = await cloneRepo({ source: fileUrl(bare), localFixtures: true, parent: h.tmpDir(), name: 'e' });
  assert.equal(res.status, 'done');
  assert.equal(res.empty, true);
  assert.ok(fs.existsSync(path.join(res.root, '.git')));
});

test('.gitmodules at the root: submodules is true and no submodule is cloned', async () => {
  const lib = h.initRepo();
  const bare = bareOf((seed) => {
    h.git(seed, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'lib');
    h.git(seed, 'commit', '-q', '-m', 'add lib');
  });
  const res = await cloneRepo({ source: fileUrl(bare), localFixtures: true, parent: h.tmpDir(), name: 's' });
  assert.equal(res.submodules, true);
  assert.equal(res.empty, false);
  assert.deepEqual(fs.readdirSync(path.join(res.root, 'lib')), [], 'the submodule folder stays empty');
});

test('checkout-failed: a 300-byte file name (git mktree) keeps the clone and resolves, as git exits 128', async () => {
  const bare = h.initRepo({ bare: true });
  const blob = gitIn(bare, 'x\n', 'hash-object', '-w', '--stdin');
  const tree = gitIn(bare, `100644 blob ${blob}\tok.txt\n100644 blob ${blob}\t${'a'.repeat(300)}\n`, 'mktree');
  const commit = gitIn(bare, '', 'commit-tree', tree, '-m', 'long name');
  h.git(bare, 'update-ref', 'refs/heads/main', commit);
  // git itself: exit 128, the repository kept.
  const raw = h.tmpDir();
  assert.throws(() => execFileSync('git', ['clone', '-q', '--', fileUrl(bare), 'x'], { cwd: raw, stdio: 'pipe' }), (e) => e.status === 128);
  assert.ok(fs.existsSync(path.join(raw, 'x', '.git')));

  const res = await cloneRepo({ source: fileUrl(bare), localFixtures: true, parent: h.tmpDir(), name: 'long' });
  assert.equal(res.status, 'checkout-failed');
  assert.equal(res.name, 'long');
  assert.match(res.message, /Clone succeeded, but checkout failed/);
  assert.match(res.message, /too long|Filename too long|cannot stat/i);
  assert.ok(fs.existsSync(path.join(res.root, '.git')), '.git kept');
  assert.equal(h.git(res.root, 'rev-parse', 'HEAD').trim(), commit, 'HEAD valid');
});

test('exists: a file, an empty folder or a folder with content at the target is refused, and nothing in it is touched', async () => {
  const { remote } = h.repoWithRemote();
  const parent = h.tmpDir();
  fs.writeFileSync(path.join(parent, 'file'), 'mine');
  fs.mkdirSync(path.join(parent, 'empty'));
  fs.mkdirSync(path.join(parent, 'full'));
  fs.writeFileSync(path.join(parent, 'full', 'keep.txt'), 'keep');
  for (const name of ['file', 'empty', 'full']) {
    const err = await cloneRepo({ source: fileUrl(remote), localFixtures: true, parent, name }).then(() => null, (e) => e);
    assert.equal(err.kind, 'exists', name);
    assert.match(err.message, new RegExp(`A folder named ${name} already exists`));
    assert.equal(err.made, undefined, 'nothing made, nothing to remove');
  }
  assert.equal(fs.readFileSync(path.join(parent, 'file'), 'utf8'), 'mine');
  assert.deepEqual(fs.readdirSync(path.join(parent, 'empty')), []);
  assert.deepEqual(fs.readdirSync(path.join(parent, 'full')), ['keep.txt']);
});

test('no-access: a parent that can\'t be written', { skip: (!posix || process.getuid() === 0) && 'POSIX permissions (and not as root)' }, async (t) => {
  const parent = h.tmpDir();
  fs.chmodSync(parent, 0o555);
  t.after(() => fs.chmodSync(parent, 0o755));
  const err = await cloneRepo({ source: 'https://example.invalid/r.git', parent, name: 'r' }).then(() => null, (e) => e);
  assert.equal(err.kind, 'no-access');
  assert.match(err.message, /can't create folders in/);
  assert.equal(err.made, undefined);
});

test('the name and the parent are checked before anything is created', async () => {
  const parent = h.tmpDir();
  for (const name of ['', '..', 'a/b', '.git']) {
    await assert.rejects(cloneRepo({ source: 'x', parent, name }), { kind: 'invalid-args' }, name);
  }
  await assert.rejects(cloneRepo({ source: 'x', parent: 'relative', name: 'r' }), { kind: 'invalid-args' });
  await assert.rejects(cloneRepo({ source: 'x', parent: path.join(parent, 'gone'), name: 'r' }), { kind: 'not-found', state: 'parent', message: /no longer exists/ });
  fs.writeFileSync(path.join(parent, 'f'), '');
  await assert.rejects(cloneRepo({ source: 'x', parent: path.join(parent, 'f'), name: 'r' }), { kind: 'not-found' });
  await assert.rejects(cloneRepo({ source: '', parent, name: 'r' }), { kind: 'invalid-args' });
  assert.deepEqual(fs.readdirSync(parent), ['f']);
});

test('the mkdir errors map to kinds (EROFS, ENOSPC, ENAMETOOLONG, Windows\' Controlled folder access hint)', () => {
  const e = (code) => Object.assign(new Error(code), { code });
  assert.equal(mkdirError(e('EROFS'), 'r', '/v', 'darwin').kind, 'no-access');
  assert.match(mkdirError(e('EROFS'), 'r', '/v', 'darwin').message, /read-only volume/);
  assert.equal(mkdirError(e('ENOSPC'), 'r', '/v', 'darwin').kind, 'no-space');
  assert.equal(mkdirError(e('ENAMETOOLONG'), 'r', '/v', 'darwin').kind, 'path-too-long');
  assert.match(mkdirError(e('EPERM'), 'r', 'C:\\v', 'win32').message, /Controlled folder access/);
  assert.doesNotMatch(mkdirError(e('EACCES'), 'r', '/v', 'darwin').message, /Controlled/);
  assert.equal(mkdirError(e('ENOENT'), 'r', '/v', 'darwin').kind, 'not-found');
  const other = e('EIO');
  assert.equal(mkdirError(other, 'r', '/v', 'darwin'), other);
  assert.match(mkdirError(e('EEXIST'), 'r', path.join(os.homedir(), 'code'), 'darwin').message, /in ~[\\/]code$/, 'the parent as shown');
});

test('not-found: a missing local path and a missing file:// repository; the folder made is removed', async () => {
  const gone = path.join(h.tmpDir(), 'nope.git');
  const local = await rejectsWithMade(cloneRepo({ source: gone, localFixtures: true, parent: h.tmpDir(), name: 'a' }), 'not-found');
  assert.match(local.message, /does not exist|does not appear to be a git repository/, 'git words it per platform (Windows: the latter)');
  assert.doesNotMatch(local.message, /Cloning into/, 'our own target is not news');
  await rejectsWithMade(cloneRepo({ source: fileUrl(gone), localFixtures: true, parent: h.tmpDir(), name: 'b' }), 'not-found');
});

test('auth: an HTTP remote that wants credentials (no prompt: GIT_TERMINAL_PROMPT=0)', async () => {
  const s = await listen((req, res) => {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="pl-test"' });
    res.end('auth required');
  });
  try {
    const err = await rejectsWithMade(cloneRepo({ source: s.url, parent: h.tmpDir(), name: 'r' }), 'auth');
    assert.match(err.message, /Username|terminal prompts/);
  } finally {
    s.close();
  }
});

test('unreachable: a server that drops the connection (held open for the test: no freed port another process could take)', async () => {
  const net = require('node:net');
  const server = net.createServer((sock) => sock.destroy());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const err = await rejectsWithMade(cloneRepo({ source: `http://127.0.0.1:${server.address().port}/r.git`, parent: h.tmpDir(), name: 'r' }), 'unreachable');
    assert.match(err.message, /Recv failure|Empty reply|reset by peer/);
  } finally {
    server.close();
  }
});

test('unsupported: a helper transport is refused by CLONE_ARGS at once (no hang)', async () => {
  const t0 = Date.now();
  const err = await rejectsWithMade(cloneRepo({ source: 'fd::3', parent: h.tmpDir(), name: 'r' }), 'unsupported');
  assert.match(err.message, /transport 'fd' not allowed/);
  assert.ok(Date.now() - t0 < 30000);
  await rejectsWithMade(cloneRepo({ source: 'ext::sh -c true', parent: h.tmpDir(), name: 'r' }), 'unsupported');
});

test('cancel while connecting: aborted, err.made set, no git left; the cleanup removes the folder', async () => {
  const ctrl = new AbortController();
  const s = await listen(() => {}); // accepts, never answers
  s.server.on('connection', () => ctrl.abort());
  try {
    const err = await rejectsWithMade(cloneRepo({ source: s.url, parent: h.tmpDir(), name: 'r', signal: ctrl.signal }), 'aborted');
    assert.ok(err.made.abs.endsWith(`${path.sep}r`));
    assert.equal(killChildren(), 0, 'no git child left');
  } finally {
    s.close();
  }
});

test('cancel during "Updating files": aborted, not checkout-failed, and the removal leaves no folder', async (t) => {
  // A slow smudge filter from the test's own global config makes the checkout last for seconds,
  // so git shows "Updating files" whatever the disk's speed.
  const bare = bareOf((seed) => {
    h.write(seed, '.gitattributes', '*.txt filter=slow\n');
    for (let i = 0; i < 300; i++) h.write(seed, `f${i}.txt`, `${i}\n`);
    h.git(seed, 'add', '-A');
    h.git(seed, 'commit', '-q', '-m', 'many');
  });
  const cfg = path.join(h.tmpDir(), 'gitconfig');
  fs.writeFileSync(cfg, `${posix ? '' : '[core]\n\thideDotFiles = false\n'}[filter "slow"]\n\tsmudge = "sleep 0.02; cat"\n`);
  const saved = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = cfg;
  t.after(() => { process.env.GIT_CONFIG_GLOBAL = saved; });
  const ctrl = new AbortController();
  const phases = [];
  const p = cloneRepo({
    source: fileUrl(bare), localFixtures: true, parent: h.tmpDir(), name: 'r', signal: ctrl.signal,
    onProgress: (f) => { phases.push(f.phase); if (f.phase === 'Updating files') ctrl.abort(); },
  });
  await rejectsWithMade(p, 'aborted');
  assert.ok(phases.includes('Updating files'), phases.join(', '));
});

test('a cancel right after git exited 0 doesn\'t fail the clone: it resolves done and nothing is removed', async (t) => {
  const { remote } = h.repoWithRemote();
  const ctrl = new AbortController();
  testHooks.afterGit = () => ctrl.abort();
  t.after(() => { testHooks.afterGit = null; });
  const res = await cloneRepo({ source: fileUrl(remote), localFixtures: true, parent: h.tmpDir(), name: 'r', signal: ctrl.signal });
  assert.equal(res.status, 'done');
  assert.equal(res.empty, false, 'the post-steps ran without the aborted signal');
  assert.ok(fs.existsSync(path.join(res.root, 'README.md')));
});

test('redaction: the message is git\'s text lines with URL credentials masked and the home folder as ~', async (t) => {
  const home = h.tmpDir();
  redact._internal.setHome(home);
  t.after(() => redact._internal.setHome());
  const gone = path.join(home, 'nope.git');
  const err = await rejectsWithMade(cloneRepo({ source: gone, localFixtures: true, parent: h.tmpDir(), name: 'r' }), 'not-found');
  assert.match(err.message, /'~[\\/]nope\.git'/);
  assert.ok(!err.message.includes(home));
  // Our own redaction of git's text lines (a server's remote: line, git's fatal: line).
  const g = new GitError(['clone'], 128, 'raw', '');
  const text = `Cloning into '${home}/r'...\nremote: see https://u:tok@h/x and ${home}/k\nfatal: repository 'https://u:tok@h/r/' not found`;
  classified(g, text);
  assert.equal(g.kind, 'not-found');
  assert.equal(g.message, "remote: see https://***@h/x and ~/k\nfatal: repository 'https://***@h/r/' not found");
  assert.equal(g.stderr, text, 'the rules read the unredacted lines; serializeError never sends stderr');
});

test('the message is always ours: with no text lines, never git\'s command line (it holds the URL), bounded', () => {
  const quiet = new GitError(['clone', '--', 'https://u:tok@h/r', '/x/r'], 128, '', '');
  assert.match(quiet.message, /tok@/, 'what GitError would say by itself');
  classified(quiet, '');
  assert.equal(quiet.message, 'git clone failed');
  const killed = Object.assign(new GitError(['clone'], null, 'git output exceeded 16777216 bytes', ''), { kind: 'too-large' });
  classified(killed, '');
  assert.equal(killed.message, 'git output exceeded 16777216 bytes', 'a kill keeps its own text');
  const long = new GitError(['clone'], 128, 'x', '');
  classified(long, Array.from({ length: 20 }, (_, i) => `remote: ${String(i).repeat(500)}`).join('\n'));
  assert.ok(long.message.length <= 2000 + 20, `${long.message.length}`);
});

test('the checkout-failed message leaves out "Cloning into" too', async () => {
  const bare = h.initRepo({ bare: true });
  const blob = gitIn(bare, 'x\n', 'hash-object', '-w', '--stdin');
  const tree = gitIn(bare, `100644 blob ${blob}\t${'b'.repeat(300)}\n`, 'mktree');
  h.git(bare, 'update-ref', 'refs/heads/main', gitIn(bare, '', 'commit-tree', tree, '-m', 'long'));
  const res = await cloneRepo({ source: fileUrl(bare), localFixtures: true, parent: h.tmpDir(), name: 'lf' });
  assert.equal(res.status, 'checkout-failed');
  assert.doesNotMatch(res.message, /Cloning into/);
});

test('a parent inside another repository: its url.<x>.insteadOf is not applied', async () => {
  const { remote } = h.repoWithRemote();
  const outer = h.initRepo();
  h.git(outer, 'config', `url.${fileUrl(path.join(h.tmpDir(), 'elsewhere.git'))}.insteadOf`, fileUrl(remote));
  const parent = path.join(outer, 'nested');
  fs.mkdirSync(parent);
  const res = await cloneRepo({ source: fileUrl(remote), localFixtures: true, parent, name: 'r' });
  assert.equal(res.status, 'done');
  assert.equal(h.read(res.root, 'README.md'), 'hello\n');
});

test('throttle: at most one frame per 100 ms (the latest wins); a new phase and a done go at once; stop ends it', async () => {
  let clock = 0;
  const sent = [];
  const th = throttle((p) => sent.push(p.n), { now: () => clock });
  const f = (n, phase = 'Receiving objects', done = false) => ({ n, phase, done, remote: false });
  th.offer(f(1));
  th.offer(f(2));
  th.offer(f(3));
  assert.deepEqual(sent, [1]);
  th.offer(f(4, 'Resolving deltas'));
  assert.deepEqual(sent, [1, 4], 'a new phase at once (the held frame of the old one is dropped)');
  th.offer(f(5, 'Resolving deltas'));
  clock = 150;
  await new Promise((r) => setTimeout(r, 130));
  assert.deepEqual(sent, [1, 4, 5], 'the held frame after the interval');
  clock = 160;
  th.offer(f(6, 'Resolving deltas'));
  th.offer(f(7, 'Resolving deltas', true));
  assert.deepEqual(sent, [1, 4, 5, 7], 'done at once');
  th.offer(f(8, 'Updating files'));
  th.stop();
  th.offer(f(9, 'Filtering content'));
  assert.deepEqual(sent, [1, 4, 5, 7, 8]);
  const boom = throttle(() => { throw new Error('listener bug'); });
  assert.doesNotThrow(() => boom.offer(f(1)));
});

test('the git command record the log gets: no -c values, the source and target only counted', async (t) => {
  const { logger } = require('../src/log');
  const logs = h.tmpDir();
  logger.configure({ dir: logs, level: 'debug', mirror: false });
  t.after(() => logger.configure({ dir: null, level: 'info' }));
  const { remote } = h.repoWithRemote();
  const res = await cloneRepo({ source: fileUrl(remote), localFixtures: true, parent: h.tmpDir(), name: 'r' });
  assert.equal(res.status, 'done');
  await logger.flush();
  const recs = fs.readFileSync(path.join(logs, 'main.log'), 'utf8').trim().split('\n').map(JSON.parse).filter((r) => r.msg === 'git command' && r.argv[0] === 'clone');
  assert.equal(recs.length, 1);
  assert.deepEqual(recs[0].argv, ['clone', '--progress', '--no-recurse-submodules', '--', '<2 paths>'], 'the URL never reaches a log');
  assert.ok(!JSON.stringify(recs).includes(path.basename(remote)), 'neither the source nor the target');
  // git sees the allowlist: the app's never allows the file transport.
  const out = await gitAt(res.root, [...CLONE_ARGS, 'config', '--get', 'protocol.file.allow'], { signal: null });
  assert.equal(out.stdout.trim(), 'never');
});

// ---------------------------------------------------------------- local folders posing as remotes

test('the app\'s clone never reads a local repository: a file:// URL and a local path are refused by the transport allowlist', async () => {
  const { remote } = h.repoWithRemote();
  for (const source of [remote, fileUrl(remote)]) {
    const err = await rejectsWithMade(cloneRepo({ source, parent: h.tmpDir(), name: 'r' }), 'unsupported');
    assert.match(err.message, /transport 'file' not allowed/);
  }
});

test('an scp-like URL naming a folder in the parent ("host:path") never clones that folder: git runs in the new target, not the parent', { skip: process.platform === 'win32' && 'a folder name with ":" can\'t exist on Windows' }, async (t) => {
  // The reviewer's scenario: <parent>/evilhost:repo.git is a repository (an earlier clone could
  // have made it while ':' was allowed in names), and the page asks for evilhost:repo.git.
  const { remote } = h.repoWithRemote();
  const parent = h.tmpDir();
  h.git(parent, 'clone', '-q', '--bare', remote, 'evilhost:repo.git');
  // ssh is faked (it says so and fails): nothing leaves the machine.
  const saved = process.env.GIT_SSH_COMMAND;
  process.env.GIT_SSH_COMMAND = 'echo pl-test-ssh-was-used >&2; exit 1 #';
  t.after(() => { if (saved === undefined) delete process.env.GIT_SSH_COMMAND; else process.env.GIT_SSH_COMMAND = saved; });
  const err = await cloneRepo({ source: 'evilhost:repo.git', parent, name: 'r' }).then(() => null, (e) => e);
  assert.ok(err && err.made, 'the clone failed');
  assert.match(err.message, /pl-test-ssh-was-used/, 'git went to ssh, never to the local folder');
  assert.equal(fs.existsSync(path.join(parent, 'r', 'README.md')), false);
  await cleanupOf().remove(err.made);
  // Even with the file transport allowed (as for the tests' fixtures), the cwd keeps it remote.
  const fixture = await cloneRepo({ source: 'evilhost:repo.git', parent, name: 'r3', localFixtures: true }).then(() => null, (e) => e);
  assert.match(fixture.message, /pl-test-ssh-was-used/);
  await cleanupOf().remove(fixture.made);
});

test('names the app refuses before git: a leading dot (~/.config would become the global git config) and ":"', async () => {
  const parent = h.tmpDir();
  for (const name of ['.config', '.ssh', '..x', 'host:path']) {
    await assert.rejects(cloneRepo({ source: 'https://h/r', parent, name, platform: 'darwin' }), { kind: 'invalid-args' }, name);
  }
  assert.deepEqual(fs.readdirSync(parent), []);
});
