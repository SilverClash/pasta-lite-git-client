'use strict';
// Removing what a failed or cancelled clone made (src/clone-cleanup.js): persisted first, only the
// folder we created (its identity checked again right before), resumable at the next launch, and
// never something the quit guard waits for.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const h = require('./helpers');
const { createCleanup, _internal: { identity, bornOf, RM_OPTIONS } } = require('../src/clone-cleanup');
const { createCloneService } = require('../src/clone-service');
const http = require('node:http');
const { createClonePrefs } = require('../src/recent');
const { cloneRepo } = require('../src/clone');
const { createQuitGuard, DIALOG_KINDS } = require('../src/quit-guard');
const ops = require('../src/ops');

const quiet = { info() {}, warn() {} };
const madeOf = (abs) => {
  const st = fs.lstatSync(abs, { bigint: true });
  const born = bornOf(st);
  return { abs, dev: String(st.dev), ino: String(st.ino), ...(born ? { born } : {}) };
};

/** A partial clone: a real folder with a .git and some files, as a killed clone leaves it. */
function partial(parent = h.tmpDir()) {
  const abs = path.join(parent, 'partial');
  fs.mkdirSync(path.join(abs, '.git', 'objects', 'pack'), { recursive: true });
  fs.writeFileSync(path.join(abs, '.git', 'objects', 'pack', 'tmp_pack_x'), 'x');
  fs.writeFileSync(path.join(abs, 'README.md'), 'x');
  return madeOf(abs);
}

function prefsAt(file = path.join(h.tmpDir(), 'clone.json')) {
  return { file, prefs: createClonePrefs(file) };
}

test('remove: persisted to clone.json first, removed, then dropped from pendingCleanup', async () => {
  const { prefs } = prefsAt();
  const made = partial();
  let pendingDuringRm = null;
  const rm = async (p, o) => {
    pendingDuringRm = await prefs.pendingCleanup();
    assert.deepEqual(o, RM_OPTIONS);
    return fs.promises.rm(p, o);
  };
  const cleanup = createCleanup({ prefs, log: quiet, rm });
  const p = cleanup.remove(made);
  assert.deepEqual(cleanup.running(), [made]);
  assert.equal(cleanup.remove(made), p, 'a second remove joins the first');
  assert.equal(await p, 'removed');
  assert.deepEqual(pendingDuringRm, [made], 'written before the removal started');
  assert.equal(fs.existsSync(made.abs), false);
  assert.deepEqual(await prefs.pendingCleanup(), []);
  assert.deepEqual(cleanup.running(), []);
  await cleanup.persisted();
  assert.equal(cleanup.writing(), false);
  assert.equal(await cleanup.remove(made), 'gone', 'nothing there: nothing to do');
});

test('a folder replaced since (a symlink, another directory, a file) is kept, untouched', async () => {
  const { prefs } = prefsAt();
  const cleanup = createCleanup({ prefs, log: quiet });
  // Another directory at the same path.
  const made = partial();
  fs.rmSync(made.abs, { recursive: true });
  fs.mkdirSync(made.abs);
  fs.writeFileSync(path.join(made.abs, 'theirs.txt'), 'theirs');
  assert.equal(await cleanup.remove(made), 'kept');
  assert.deepEqual(fs.readdirSync(made.abs), ['theirs.txt']);
  // A file.
  const m2 = partial();
  fs.rmSync(m2.abs, { recursive: true });
  fs.writeFileSync(m2.abs, 'a file');
  assert.equal(await cleanup.remove(m2), 'kept');
  assert.equal(fs.readFileSync(m2.abs, 'utf8'), 'a file');
  // No inode numbers: never matches.
  const m3 = partial();
  assert.equal(await cleanup.remove({ ...m3, ino: '0' }), 'kept');
  assert.ok(fs.existsSync(path.join(m3.abs, 'README.md')));
  assert.deepEqual(await prefs.pendingCleanup(), [], 'kept entries are dropped too');
});

test('a symlink put where the folder was is kept, and what it points to is untouched', { skip: process.platform === 'win32' && 'symlinks need privileges on Windows' }, async () => {
  const { prefs } = prefsAt();
  const made = partial();
  const elsewhere = h.tmpDir();
  fs.writeFileSync(path.join(elsewhere, 'precious.txt'), 'x');
  fs.rmSync(made.abs, { recursive: true });
  fs.symlinkSync(elsewhere, made.abs);
  assert.equal(await identity(made), 'other');
  assert.equal(await createCleanup({ prefs, log: quiet }).remove(made), 'kept');
  assert.deepEqual(fs.readdirSync(elsewhere), ['precious.txt']);
  assert.ok(fs.lstatSync(made.abs).isSymbolicLink());
});

test('a failed removal stays pending (logged without the path) and the next launch finishes it', async () => {
  const { prefs, file } = prefsAt();
  const made = partial();
  const warned = [];
  const failing = createCleanup({ prefs, log: { info() {}, warn: (m, f) => warned.push([m, f]) }, rm: async () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); } });
  assert.equal(await failing.remove(made), 'failed');
  assert.deepEqual(warned.map(([, f]) => f), [{ error: 'EBUSY' }]);
  assert.deepEqual(await prefs.pendingCleanup(), [made]);
  // "Next launch": fresh prefs on the same file, a real rm.
  const next = createCleanup({ prefs: createClonePrefs(file), log: quiet });
  await next.resume();
  assert.equal(fs.existsSync(made.abs), false);
  assert.deepEqual(await createClonePrefs(file).pendingCleanup(), []);
});

test('resume at startup removes a pending entry whose identity matches and keeps one that doesn\'t', async () => {
  const { prefs, file } = prefsAt();
  const ours = partial();
  const replaced = partial();
  await prefs.addPendingCleanup(ours);
  await prefs.addPendingCleanup(replaced);
  await prefs.addPendingCleanup({ abs: path.join(h.tmpDir(), 'never-made'), dev: '1', ino: '2' });
  fs.rmSync(replaced.abs, { recursive: true });
  fs.mkdirSync(replaced.abs); // the user made a folder of that name since
  await createCleanup({ prefs: createClonePrefs(file), log: quiet }).resume();
  assert.equal(fs.existsSync(ours.abs), false);
  assert.ok(fs.existsSync(replaced.abs), 'not ours any more: kept');
  assert.deepEqual(await prefs.pendingCleanup(), [], 'every entry settled');
  await createCleanup({ prefs: { pendingCleanup: async () => { throw new Error('x'); } }, log: quiet }).resume(); // never rejects
});

/** A clone service over the real runner, clone.json and cleanup; `run` replaces the runner's run (a git that never settles). */
function serviceAt({ parent, file, rm, run } = {}) {
  const prefs = createClonePrefs(file);
  const cleanup = createCleanup({ prefs, log: quiet, ...(rm ? { rm } : {}) });
  const runner = ops.createRunner({ log: { log() {} } });
  if (run) runner.run = run;
  const service = createCloneService({
    runner, cleanup, prefs: { lastParent: async () => parent, setLastParent: async () => {} },
    opening: { openCloned: async (s, dir) => ({ info: { root: dir, name: path.basename(dir) } }), rememberRecent: async () => {} },
    pickFolder: async () => null, home: () => null, log: quiet, homeDir: () => '/nowhere',
  });
  return { service, cleanup, runner };
}
const tab = (id) => ({ id, closed: false, send() {} });

test('a removal outlasting the quit bound: the clone\'s own runner has nothing left, quitting doesn\'t wait or ask, the next launch finishes it', async () => {
  const parent = h.tmpDir();
  const { file } = prefsAt();
  let release;
  const stuck = new Promise((r) => { release = r; });
  const { service, cleanup, runner } = serviceAt({ parent, file, rm: () => stuck });
  // A real clone that fails (a local server drops the connection): its folder goes to the cleanup, whose rm hangs.
  const drop = require('node:net').createServer((sock) => sock.destroy());
  await new Promise((r) => drop.listen(0, '127.0.0.1', r));
  const err = await service.clone(tab(1), { url: `http://127.0.0.1:${drop.address().port}/r.git`, name: 'r', parent }, 'a').then(() => null, (e) => e);
  drop.close();
  assert.ok(err && err.made, `failed with a folder made (${err && err.kind})`);
  await cleanup.persisted(); // deterministic: every clone.json write so far has landed
  assert.deepEqual(await createClonePrefs(file).pendingCleanup(), [err.made]);
  assert.deepEqual(runner.running(), [], 'the clone settled: the removal is no runner op');
  const asked = [];
  const guard = createQuitGuard({ runner, killChildren: () => 0, confirm: async (kind) => { asked.push(kind); return true; }, boundMs: 50, graceMs: 10 });
  assert.equal(guard.needsConfirm(), false);
  assert.equal(await guard.run(), 'quit');
  assert.deepEqual(asked, [], `no ${DIALOG_KINDS.UNSAFE} question`);
  assert.deepEqual(await createClonePrefs(file).pendingCleanup(), [err.made], 'still in clone.json when the process would exit');
  await createCleanup({ prefs: createClonePrefs(file), log: quiet }).resume(); // the next launch
  assert.equal(fs.existsSync(err.made.abs), false);
  release();
});

test('quit while git outlives its kill (UNSAFE, Quit): clone.json already holds the folder, and the next launch removes it', async () => {
  const parent = h.tmpDir();
  const { file } = prefsAt();
  // The clone's folder is made, then its git never settles (it ignored SIGTERM and SIGKILL).
  let made = null;
  const { service, cleanup, runner } = serviceAt({
    parent, file,
    run: (target, name, [, hooks]) => {
      fs.mkdirSync(target);
      made = madeOf(target);
      fs.writeFileSync(path.join(target, 'partial'), 'x');
      hooks.onMade(made);
      return new Promise(() => {});
    },
  });
  service.clone(tab(1), { url: 'git@host:o/r.git', name: 'r', parent }, 'a');
  await new Promise((r) => setImmediate(r));
  assert.ok(made);
  const busy = { running: () => [{ op: 'clone', write: true, started: true, cancelled: true }], cancelAll: () => 1, settled: () => new Promise(() => {}) };
  const asked = [];
  const guard = createQuitGuard({ runner: busy, killChildren: () => 0, confirm: async (kind) => { asked.push(kind); return true; }, boundMs: 10, graceMs: 10 });
  assert.equal(await guard.run(), 'quit');
  assert.deepEqual(asked, [DIALOG_KINDS.RUNNING, DIALOG_KINDS.UNSAFE]);
  // before-quit (main.js): the journal writes land before the app exits.
  await cleanup.persisted();
  assert.deepEqual(await createClonePrefs(file).pendingCleanup(), [made], 'pending although the op never settled');
  assert.equal(runner.running().length, 0);
  await createCleanup({ prefs: createClonePrefs(file), log: quiet }).resume();
  assert.equal(fs.existsSync(made.abs), false);
});

test('a real clone cancelled by quitting: clone.json holds its folder from the moment it existed', async () => {
  const parent = h.tmpDir();
  const { file } = prefsAt();
  const server = http.createServer(() => {}); // accepts, never answers
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    let release;
    const stuck = new Promise((r) => { release = r; });
    const { service, cleanup, runner } = serviceAt({ parent, file, rm: () => stuck });
    const connected = new Promise((r) => server.once('connection', r));
    const p = service.clone(tab(1), { url: `http://127.0.0.1:${server.address().port}/r.git`, name: 'r', parent }, 'a').catch((e) => e);
    await connected; // git runs: its folder exists
    await cleanup.persisted();
    const target = path.join(parent, 'r');
    assert.deepEqual((await createClonePrefs(file).pendingCleanup()).map((m) => m.abs), [target], 'journalled before any failure');
    const guard = createQuitGuard({ runner, killChildren: () => 0, confirm: async () => true });
    assert.equal(await guard.run(), 'quit');
    assert.equal((await p).kind, 'aborted');
    await cleanup.persisted();
    assert.deepEqual((await createClonePrefs(file).pendingCleanup()).map((m) => m.abs), [target], 'its removal was cut short by the exit: still pending');
    await createCleanup({ prefs: createClonePrefs(file), log: quiet }).resume();
    assert.equal(fs.existsSync(target), false);
    release();
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('identity: an inode reused for a later folder at the same path is not ours (its birth time differs)', async () => {
  const made = partial();
  assert.equal(await identity(made), 'same');
  if (made.born) {
    assert.equal(await identity({ ...made, born: String(BigInt(made.born) + 1n) }), 'other', 'same dev and inode, another birth');
  }
  assert.equal(await identity({ ...made, born: undefined }), 'same', 'an entry without a birth time (none kept): dev and inode decide');
  // No birth time to compare: none kept, or the ctime reported in its place.
  assert.equal(bornOf({ birthtimeNs: 0n, ctimeNs: 5n }), null);
  assert.equal(bornOf({ birthtimeNs: 5n, ctimeNs: 5n }), null);
  assert.equal(bornOf({ birthtimeNs: 4n, ctimeNs: 5n }), '4');
});

test('a new clone\'s folder replaces every pending entry for the same path (resume never deletes it)', async () => {
  const { prefs, file } = prefsAt();
  const old = partial();
  await prefs.addPendingCleanup(old);
  await prefs.addPendingCleanup({ abs: old.abs, dev: '1', ino: '2' });
  fs.rmSync(old.abs, { recursive: true });
  fs.mkdirSync(old.abs); // a later clone made a folder there (maybe on the same inode)
  const fresh = madeOf(old.abs);
  const cleanup = createCleanup({ prefs, log: quiet });
  await cleanup.journal(fresh);
  assert.deepEqual(await prefs.pendingCleanup(), [fresh], 'the older entries are gone');
  await cleanup.forget(fresh); // that clone succeeded
  assert.deepEqual(await prefs.pendingCleanup(), []);
  await createCleanup({ prefs: createClonePrefs(file), log: quiet }).resume();
  assert.ok(fs.existsSync(old.abs), 'the later clone is untouched');
});

test('a real clone cancelled after its first frame on Windows: taskkill /F leaves files, and the removal deletes them all', { skip: process.platform !== 'win32' && 'Windows: the hard kill leaves read-only pack files and the hidden .git' }, async () => {
  // Short paths (CONTRIBUTING.md): a bare repo with enough content for several progress frames.
  const seed = h.initRepo();
  for (let i = 0; i < 200; i++) h.write(seed, `f${i}.txt`, `${i}\n`.repeat(200));
  h.git(seed, 'add', '-A');
  h.git(seed, 'commit', '-q', '-m', 'many');
  const bare = h.tmpDir();
  h.git(bare, 'clone', '-q', '--bare', seed, '.');
  // Git for Windows' own default: hide the .git it creates (the tests' global config turns it off).
  const cfg = path.join(h.tmpDir(), 'gitconfig');
  fs.writeFileSync(cfg, '[core]\n\thideDotFiles = dotGitOnly\n');
  const saved = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = cfg;
  try {
    const ctrl = new AbortController();
    const err = await cloneRepo({ source: pathToFileURL(bare).href, parent: h.tmpDir(), name: 'r', signal: ctrl.signal, onProgress: () => ctrl.abort() })
      .then(() => null, (e) => e);
    assert.ok(err, 'cancelled');
    assert.equal(err.kind, 'aborted');
    const { prefs } = prefsAt();
    assert.equal(await createCleanup({ prefs, log: quiet }).remove(err.made), 'removed');
    assert.equal(fs.existsSync(err.made.abs), false);
  } finally {
    process.env.GIT_CONFIG_GLOBAL = saved;
  }
});

test('a read-only file in the folder (as Windows\' pack files are) is removed too', async () => {
  const { prefs } = prefsAt();
  const made = partial();
  const pack = path.join(made.abs, '.git', 'objects', 'pack', 'pack-1.pack');
  fs.writeFileSync(pack, 'x');
  fs.chmodSync(pack, 0o444);
  assert.equal(await createCleanup({ prefs, log: quiet }).remove(made), 'removed');
  assert.equal(fs.existsSync(made.abs), false);
});
