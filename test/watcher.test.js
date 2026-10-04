'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const h = require('./helpers');
const { createWatcher, classify, noisyGit, MAX_CHECK, MAX_PATHS } = require('../src/watcher');

// ---------------------------------------------------------------- classify

describe('classify', () => {
  const cases = {
    work: ['src/a.js', 'README.md', 'yarn.lock', 'Cargo.lock', 'dir', 'a b/c d.txt', '.github/ci.yml', '.gitmodules',
      '.gitattributes', 'src\\win\\file.txt', './x.txt', '', null, undefined],
    ignores: ['.gitignore', 'sub/.gitignore', 'sub\\deep\\.gitignore', '.git/info/exclude'],
    status: ['.git/index', '.git\\index'],
    full: ['.git/HEAD', '.git/refs/heads/main', '.git/refs/heads/feat/x', '.git/refs/heads', '.git/MERGE_HEAD',
      '.git/REBASE_HEAD', '.git/CHERRY_PICK_HEAD', '.git/REVERT_HEAD', '.git/BISECT_LOG', '.git/AUTO_MERGE',
      '.git/rebase-merge', '.git/rebase-merge/done', '.git/rebase-apply/next', '.git/sequencer/todo',
      '.git\\refs\\heads\\main'],
    refs: ['.git/worktrees', '.git/worktrees/x', '.git/worktrees/wt/HEAD', '.git/worktrees/x/locked', '.git/locked',
      '.git/refs/remotes/origin/main', '.git/refs/remotes/origin', '.git/refs/tags/v1', '.git/refs/tags',
      '.git/packed-refs', '.git/config'],
    stashes: ['.git/refs/stash', '.git/logs/refs/stash'],
  };
  for (const [kind, paths] of Object.entries(cases)) {
    test(`→ ${kind}`, () => {
      for (const p of paths) assert.equal(classify(p), kind, String(p));
    });
  }
  test('→ ignored (null)', () => {
    for (const p of [
      '.git', '.git/index.lock', '.git/HEAD.lock', '.git/refs/heads/main.lock', '.git/packed-refs.lock',
      '.git/config.lock', '.git/refs/stash.lock', '.git/logs/HEAD', '.git/logs/refs/heads/main',
      '.git/logs/refs/remotes/origin/main', '.git/FETCH_HEAD', '.git/ORIG_HEAD', '.git/COMMIT_EDITMSG',
      '.git/hooks/pre-commit', '.git/description', '.git/refs/pasta-lite/backups/abc', '.git/refs/notes/commits',
      '.git/modules/sub/HEAD', 'nested/.git/index', 'sub/.git', '.git\\index.lock',
      // objects are written by fetch, gc, hash-object...: staging also writes the index.
      '.git/objects/ab/cdef', '.git/objects/pack/pack-1.pack', '.git/objects', '.git\\objects\\12\\34',
    ]) assert.equal(classify(p), null, p);
  });
});
// ---------------------------------------------------------------- fakes

function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map(); // id -> {at, fn}
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    pending: () => timers.size,
    /** Advance time by ms, firing due timers in order. */
    tick(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
  };
}

/** Fake fs.watch. `burst(base, listener)` runs inside the call (Linux: the initial walk's events). */
function fakeFs({ burst = null } = {}) {
  const watches = [];
  const fsWatch = (base, opts, listener) => {
    assert.equal(opts.recursive, true);
    assert.ok(opts.ignore === undefined || typeof opts.ignore === 'function', 'ignore: a function or nothing');
    const w = Object.assign(new EventEmitter(), { base, opts, listener, closed: false });
    w.close = () => { w.closed = true; };
    if (burst) burst(base, listener);
    watches.push(w);
    return w;
  };
  return { fsWatch, watches, fire: (name, i = 0) => watches[i].listener('change', name) };
}

const settle = () => new Promise((r) => setImmediate(r));

/**
 * Watcher over a real (empty) temp dir with fake fs.watch, clock and ignore check.
 * `internal` is createWatcher's test-only second argument (gitDir '.git' by default).
 * The platform defaults to 'darwin' whatever the host: there the root is watched synchronously, so
 * tests can fire events before `ready`. On 'linux' the watch starts only after the gitdirs and the
 * ignored entries are known; the Linux path has its own tests (platform: 'linux').
 */
function setup({ ignored = () => false, internal = {}, fs: fsOpts, ...o } = {}) {
  const root = h.tmpDir();
  const clock = fakeClock();
  const f = fakeFs(fsOpts);
  const events = [];
  const checks = [];
  const logged = [];
  const w = createWatcher(root, {
    onEvent: (e) => events.push(e), fsWatch: f.fsWatch, clock, debounceWork: 2000, debounceRefs: 250,
    isIgnored: async (paths) => { checks.push(paths); return paths.filter(ignored); },
    log: (...a) => logged.push(a),
    ...o,
  }, { gitDir: '.git', platform: 'darwin', ...internal });
  const advance = async (ms) => { clock.tick(ms); await settle(); await settle(); };
  return { root, clock, events, checks, logged, w, advance, ...f };
}

// ---------------------------------------------------------------- batching (fake fs + clock)

describe('batching', () => {
  test('working-folder edits are debounced 2 s and filtered once per window', async () => {
    const s = setup();
    await s.w.ready;
    s.fire('a.txt');
    s.fire('b.txt');
    s.fire('a.txt');
    await s.advance(1999);
    assert.deepEqual(s.events, []);
    await s.advance(1);
    assert.deepEqual(s.events, [{ kinds: ['status'], paths: ['a.txt', 'b.txt'] }]);
    assert.deepEqual(s.checks, [['a.txt', 'b.txt']]);
    s.w.close();
  });

  test('ref changes are debounced 250 ms; full subsumes the rest; locks, logs and objects are ignored', async () => {
    const s = setup();
    s.fire('.git/refs/tags/v1');
    s.fire('.git/refs/stash');
    s.fire('.git/HEAD.lock');
    s.fire('.git/logs/HEAD');
    await s.advance(250);
    assert.deepEqual(s.events, [{ kinds: ['refs', 'stashes'] }]);
    s.fire('.git/index');
    s.fire('.git/refs/heads/main');
    s.fire('x.txt');
    await s.advance(250);
    assert.deepEqual(s.events[1], { kinds: ['full'] });
    assert.deepEqual(s.checks, [], 'full needs no ignore check');
    await s.advance(5000);
    assert.equal(s.events.length, 2, 'the working-folder change was merged into the full batch');
    s.fire('.git/index.lock');
    s.fire('.git/FETCH_HEAD');
    for (let i = 0; i < 20; i++) s.fire(`.git/objects/${i}/abc`); // a fetch, gc, hash-object -w
    await s.advance(5000);
    assert.equal(s.events.length, 2);
    s.w.close();
  });

  test('a ref flush takes pending working-folder changes without checking them', async () => {
    const s = setup();
    s.fire('src/a.js');
    await s.advance(100);
    s.fire('.git/refs/remotes/origin/main');
    await s.advance(250);
    // refs is a full refresh in the renderer: which files changed doesn't matter.
    assert.deepEqual(s.events, [{ kinds: ['refs', 'status'] }]);
    assert.deepEqual(s.checks, []);
    s.fire('.git/refs/tags/v1');
    await s.advance(250);
    assert.deepEqual(s.events[1], { kinds: ['refs'] }, 'a refs-only batch: nothing to check');
    assert.deepEqual(s.checks, []);
    s.w.close();
  });

  test('ignored paths emit nothing; a node_modules flood spawns one check and caches it', async () => {
    const s = setup({ ignored: (p) => p.startsWith('node_modules/') });
    for (let i = 0; i < 3000; i++) s.fire(`node_modules/pkg${i % 1000}/index.js`);
    await s.advance(2000);
    assert.deepEqual(s.events, []);
    assert.equal(s.checks.length, 1);
    assert.equal(s.checks[0].length, 1000);
    s.fire('node_modules/pkg1/index.js');
    await s.advance(2000);
    assert.equal(s.checks.length, 1, 'cached');
    s.fire('node_modules/pkg1/index.js');
    s.fire('src/real.js');
    await s.advance(2000);
    assert.deepEqual(s.checks[1], ['src/real.js'], 'only the uncached path is checked');
    assert.deepEqual(s.events, [{ kinds: ['status'], paths: ['src/real.js'] }]);
    s.w.close();
  });

  test('.gitignore / info/exclude / index changes drop the ignore cache', async () => {
    const s = setup({ ignored: (p) => p === 'build.log' });
    s.fire('build.log');
    await s.advance(2000);
    assert.equal(s.checks.length, 1);
    s.fire('.gitignore');
    await s.advance(2000);
    assert.deepEqual(s.events, [{ kinds: ['status'], paths: ['.gitignore'] }], 'a .gitignore edit is a status change itself');
    s.fire('build.log');
    await s.advance(2000);
    assert.equal(s.checks.length, 3, 're-checked after the .gitignore change');
    s.fire('.git/info/exclude');
    await s.advance(250);
    assert.deepEqual(s.events[1], { kinds: ['status'] });
    s.fire('build.log');
    await s.advance(2000);
    assert.equal(s.checks.length, 4);
    s.fire('.git/index'); // `git add -f build.log`: now tracked, so no longer ignored
    await s.advance(250);
    assert.deepEqual(s.events[2], { kinds: ['status'] });
    s.fire('build.log');
    await s.advance(2000);
    assert.equal(s.checks.length, 5, 're-checked after the index changed');
    assert.equal(s.events.length, 3);
    s.w.close();
  });

  test('a .gitignore inside an ignored folder keeps the cache', async () => {
    const s = setup({ ignored: (p) => p.startsWith('node_modules/') });
    s.fire('node_modules/a/index.js');
    await s.advance(2000);
    s.fire('node_modules/a/.gitignore');
    await s.advance(2000);
    assert.deepEqual(s.events, []);
    assert.deepEqual(s.checks, [['node_modules/a/index.js'], ['node_modules/a/.gitignore']]);
    s.fire('node_modules/a/index.js');
    await s.advance(2000);
    assert.equal(s.checks.length, 2, 'still cached');
    s.w.close();
  });

  test('a failing ignore check counts every path, is logged once and not re-run for a while', async () => {
    let calls = 0;
    const s = setup({ isIgnored: async () => { calls++; throw new Error('fatal: in submodule'); } });
    s.fire('sub/file');
    await s.advance(2000);
    assert.deepEqual(s.events, [{ kinds: ['status'], paths: ['sub/file'] }]);
    assert.equal(s.logged.length, 1);
    assert.match(String(s.logged[0][1].message), /in submodule/);
    assert.equal(s.logged[0][0], 'git check-ignore failed (every changed file counts):');
    s.fire('sub/other');
    await s.advance(2000);
    assert.deepEqual(s.events[1], { kinds: ['status'], paths: ['sub/other'] });
    assert.equal(calls, 1, 'the failure is cached (ignoreCacheMs)');
    await s.advance(10000);
    s.fire('sub/third');
    await s.advance(2000);
    assert.equal(calls, 2, 'asked again later');
    assert.equal(s.logged.length, 1, 'the same message is logged once');
    s.w.close();
  });

  test('a null filename, Windows separators and paths outside the root', async () => {
    const s = setup();
    s.fire(null);
    await s.advance(2000);
    assert.deepEqual(s.events, [{ kinds: ['status'] }], 'unknown path: no paths, no ignore check');
    assert.deepEqual(s.checks, []);
    s.fire(path.join('.git', 'refs', 'heads', 'x'));
    await s.advance(250);
    assert.deepEqual(s.events[1], { kinds: ['full'] });
    s.fire(path.join('..', 'elsewhere.txt'));
    await s.advance(5000);
    assert.equal(s.events.length, 2);
    s.w.close();
  });

  test('MAX_CHECK distinct paths are checked; one more is a status refresh without a check', async () => {
    const s = setup({ ignored: () => true });
    for (let i = 0; i < MAX_CHECK; i++) s.fire(`gen/f${i}`);
    await s.advance(2000);
    assert.equal(s.checks.length, 1);
    assert.equal(s.checks[0].length, MAX_CHECK);
    assert.deepEqual(s.events, []);
    for (let i = 0; i <= MAX_CHECK; i++) s.fire(`gen2/f${i}`);
    await s.advance(2000);
    assert.equal(s.checks.length, 1, 'too many: not checked');
    assert.deepEqual(s.events, [{ kinds: ['status'] }]);
    s.w.close();
  });

  test('paths are sent up to MAX_PATHS', async () => {
    const s = setup();
    const names = (n, dir) => Array.from({ length: n }, (_, i) => `${dir}/f${i}`);
    for (const p of names(MAX_PATHS, 'a')) s.fire(p);
    await s.advance(2000);
    assert.deepEqual(s.events, [{ kinds: ['status'], paths: names(MAX_PATHS, 'a') }]);
    for (const p of names(MAX_PATHS + 1, 'b')) s.fire(p);
    await s.advance(2000);
    assert.deepEqual(s.events[1], { kinds: ['status'] });
    s.w.close();
  });

  test('ignore cache overflow keeps the batch (4 × 4999 paths, then 1 cached + 10 new)', async () => {
    const unhandled = [];
    const onUnhandled = (e) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const s = setup();
      for (let b = 0; b < 4; b++) {
        for (let i = 0; i < 4999; i++) s.fire(`d${b}/f${i}`);
        await s.advance(2000);
      }
      assert.equal(s.events.length, 4);
      s.fire('d0/f1'); // cached, and among the oldest entries: evicted by this very batch
      for (let i = 0; i < 10; i++) s.fire(`new/f${i}`);
      await s.advance(2000);
      await settle();
      assert.deepEqual(s.events[4], { kinds: ['status'], paths: ['d0/f1', ...Array.from({ length: 10 }, (_, i) => `new/f${i}`)] });
      assert.deepEqual(s.checks.at(-1), Array.from({ length: 10 }, (_, i) => `new/f${i}`), 'the cached path is not re-checked');
      assert.deepEqual(unhandled, []);
      assert.deepEqual(s.logged, []);
      s.w.close();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('a filtering failure is logged and falls back to a status refresh', async () => {
    const s = setup({ isIgnored: async () => 42 }); // not iterable: a bug past the check itself
    s.fire('a.txt');
    await s.advance(2000);
    assert.deepEqual(s.events, [{ kinds: ['status'] }]);
    assert.equal(s.logged.length, 1);
    assert.match(s.logged[0][0], /could not filter/);
    assert.doesNotMatch(s.logged[0][0], /\[watcher\]/, 'the logger\'s watcher scope names it already');
    s.fire('b.txt');
    await s.advance(2000);
    assert.equal(s.events.length, 2, 'the watcher keeps working');
    s.w.close();
  });
});

describe('trailing debounce', () => {
  test('working folder: 2 s after the last change', async () => {
    const s = setup();
    s.fire('a.txt');
    await s.advance(1500);
    s.fire('b.txt');
    await s.advance(1500);
    s.fire('c.txt');
    await s.advance(1999);
    assert.deepEqual(s.events, [], 'still busy');
    await s.advance(1);
    assert.deepEqual(s.events, [{ kinds: ['status'], paths: ['a.txt', 'b.txt', 'c.txt'] }]);
    s.w.close();
  });

  test('working folder: at most 10 s after the first change', async () => {
    const s = setup();
    for (let t = 0; t < 10000; t += 1000) {
      s.fire(`f${t}.txt`);
      await s.advance(1000);
    }
    assert.equal(s.events.length, 1, 'emitted at 10 s despite the changes every second');
    assert.equal(s.events[0].paths.length, 10);
    s.w.close();
  });

  test('refs: 250 ms after the last change, at most 1 s after the first', async () => {
    const s = setup();
    s.fire('.git/refs/tags/a');
    await s.advance(200);
    s.fire('.git/refs/tags/b');
    await s.advance(249);
    assert.deepEqual(s.events, []);
    await s.advance(1);
    assert.deepEqual(s.events, [{ kinds: ['refs'] }]);
    for (let t = 0; t < 1000; t += 100) {
      s.fire('.git/refs/tags/c');
      await s.advance(100);
    }
    assert.equal(s.events.length, 2, 'emitted at 1 s');
    s.w.close();
  });

  test('the maxWait values are options', async () => {
    const s = setup({ maxWaitWork: 3000 });
    for (let t = 0; t < 3000; t += 1000) {
      s.fire('a.txt');
      await s.advance(1000);
    }
    assert.equal(s.events.length, 1);
    s.w.close();
  });
});

describe('pause / resume', () => {
  test('nothing while paused; the last resume emits one merged batch', async () => {
    const s = setup();
    s.w.pause();
    s.w.pause();
    s.fire('a.txt');
    s.fire('.git/refs/tags/v1');
    s.fire('.git/refs/stash');
    await s.advance(10000);
    assert.deepEqual(s.events, []);
    assert.equal(s.clock.pending(), 0, 'no timers while paused');
    s.w.resume();
    await s.advance(10000);
    assert.deepEqual(s.events, [], 'still paused once');
    s.w.resume();
    await s.advance(0);
    assert.deepEqual(s.events, [{ kinds: ['refs', 'stashes', 'status'] }]);
    await s.advance(10000);
    assert.equal(s.events.length, 1);
    s.w.resume(); // unbalanced: ignored
    s.w.close();
  });

  test('resume with nothing pending emits nothing', async () => {
    const s = setup();
    s.w.pause();
    s.w.resume();
    await s.advance(5000);
    assert.deepEqual(s.events, []);
    s.w.close();
  });

  test('pending changes from before the pause are held until resume', async () => {
    const s = setup();
    s.fire('.git/HEAD');
    s.w.pause();
    await s.advance(1000);
    assert.deepEqual(s.events, []);
    s.fire('.git/index');
    s.w.resume();
    await s.advance(0);
    assert.deepEqual(s.events, [{ kinds: ['full'] }]);
    s.w.close();
  });

  test('a flush that races a pause is merged into the single resume batch, paths kept', async () => {
    const gate = {};
    const s = setup({ isIgnored: (paths) => new Promise((r) => { gate.open = () => r([]); void paths; }) });
    s.fire('a.txt');
    await s.advance(2000); // ignore check in flight
    s.w.pause();
    s.fire('.git/refs/tags/v1');
    gate.open();
    await s.advance(0);
    assert.deepEqual(s.events, []);
    s.w.resume();
    await s.advance(0);
    assert.deepEqual(s.events, [{ kinds: ['refs', 'status'], paths: ['a.txt'] }]);
    await s.advance(10000);
    assert.equal(s.events.length, 1);
    s.w.close();
  });

  test('a long pause collects at most MAX_CHECK paths, then just a status refresh', async () => {
    const s = setup();
    s.w.pause();
    for (let i = 0; i < MAX_CHECK * 2; i++) s.fire(`gen/f${i}`);
    s.w.resume();
    await s.advance(0);
    assert.deepEqual(s.events, [{ kinds: ['status'] }]);
    assert.deepEqual(s.checks, []);
    s.w.close();
  });

  test('after the last resume, late git-internal changes are dropped for debounceRefs; worktree edits are kept', async () => {
    const s = setup();
    s.w.pause();
    s.w.resume();
    await s.advance(100);
    // FSEvents delivering our own write after busy:false.
    for (const p of ['.git/index', '.git/HEAD', '.git/refs/heads/main', '.git/refs/tags/v1', '.git/refs/stash', '.git/config']) s.fire(p);
    s.fire('edited-outside.txt');
    await s.advance(2000);
    assert.deepEqual(s.events, [{ kinds: ['status'], paths: ['edited-outside.txt'] }]);
    await s.advance(0);
    s.fire('.git/HEAD'); // well after the grace window: a real change
    await s.advance(250);
    assert.deepEqual(s.events[1], { kinds: ['full'] });
    s.w.close();
  });

  test('the grace window starts at the last resume only, and is an option', async () => {
    const s = setup({ resumeGrace: 1000 });
    s.w.pause();
    s.w.pause();
    s.w.resume();
    s.fire('.git/HEAD'); // still paused once: collected
    s.w.resume();
    await s.advance(0);
    assert.deepEqual(s.events, [{ kinds: ['full'] }]);
    await s.advance(900);
    s.fire('.git/refs/tags/v1');
    await s.advance(250);
    assert.equal(s.events.length, 1, 'inside the 1 s grace');
    s.fire('.git/refs/tags/v2');
    await s.advance(250);
    assert.deepEqual(s.events[1], { kinds: ['refs'] });
    s.w.close();
  });
});

describe('Linux (JS recursive watch)', () => {
  const linux = (o = {}) => {
    const lists = [];
    const s = setup({
      internal: { platform: 'linux', ignoredEntries: async () => { lists.push(1); return o.entries ? o.entries() : ['build', 'x.log']; } },
      ...o.setup,
    });
    return { ...s, lists };
  };

  test('the root is watched once the ignored entries are listed; the walk skips the noisy parts', async () => {
    const s = linux();
    assert.equal(s.watches.length, 0, 'not before ready');
    await s.w.ready;
    assert.equal(s.watches.length, 1);
    assert.equal(s.lists.length, 1);
    const skip = s.watches[0].opts.ignore;
    const n = (p) => p.split('/').join(path.sep);
    for (const p of ['node_modules', 'a/b/node_modules', 'a/node_modules/x', '.git/objects', '.git/objects/ab',
      '.git/logs/HEAD', '.git/logs/refs/heads', '.git/modules', '.git/worktrees/x/index', '.git/worktrees/x/logs', '.git/lfs', 'nested/.git', 'build', 'x.log']) {
      assert.equal(skip(n(p)), true, p);
    }
    for (const p of ['src', 'src/a.js', '.git', '.git/refs', '.git/refs/heads/main', '.git/logs', '.git/logs/refs',
      '.git/logs/refs/stash', '.git/index', '.git/info', '.git/worktrees', '.git/worktrees/x', '.git/worktrees/x/HEAD', 'build2', 'sub/build']) {
      assert.equal(skip(n(p)), false, p);
    }
    s.w.close();
  });

  test('events fired synchronously during fs.watch (the initial walk) are dropped', async () => {
    const s = setup({
      internal: { platform: 'linux', ignoredEntries: async () => [] },
      fs: { burst: (_base, listener) => { for (const p of ['a.txt', 'src', '.git/HEAD', '.git/index']) listener('rename', p); } },
    });
    await s.w.ready;
    await s.advance(10000);
    assert.deepEqual(s.events, []);
    s.fire('a.txt');
    await s.advance(2000);
    assert.deepEqual(s.events, [{ kinds: ['status'], paths: ['a.txt'] }], 'later events count');
    s.w.close();
  });

  test('ignore rules changing re-lists the ignored entries', async () => {
    let entries = ['build'];
    const s = linux({ entries: () => entries });
    await s.w.ready;
    const skip = s.watches[0].opts.ignore;
    assert.equal(skip('dist'), false);
    entries = ['build', 'dist'];
    s.fire('.gitignore');
    await s.advance(2000);
    await settle();
    assert.equal(s.lists.length, 2);
    assert.equal(skip('dist'), true);
    s.fire('.git/info/exclude');
    await settle();
    assert.equal(s.lists.length, 3);
    s.w.close();
  });

  test('a failing listing is logged and watches everything', async () => {
    const s = setup({ internal: { platform: 'linux', ignoredEntries: async () => { throw new Error('boom'); } } });
    await s.w.ready;
    assert.equal(s.watches.length, 1);
    assert.equal(s.watches[0].opts.ignore('build'), false);
    assert.equal(s.watches[0].opts.ignore('node_modules'), true);
    assert.equal(s.logged.length, 1);
    s.w.close();
  });

  test('other platforms watch the root right away, without ignore', () => {
    const s = setup({ internal: { platform: 'darwin' } });
    assert.equal(s.watches.length, 1);
    assert.deepEqual(s.watches[0].opts, { recursive: true });
    s.w.close();
  });
});

describe('robustness', () => {
  test('a watcher error closes everything and is reported once', async () => {
    const s = setup();
    s.fire('a.txt');
    const err = Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
    s.watches[0].emit('error', err);
    s.watches[0].emit('error', err);
    await s.advance(0);
    assert.deepEqual(s.events, [{ kinds: ['error'], error: err }]);
    assert.ok(s.watches.every((w) => w.closed));
    assert.equal(s.clock.pending(), 0);
    s.fire('b.txt'); // late event after close
    await s.advance(5000);
    assert.equal(s.events.length, 1);
  });

  test('fs.watch throwing synchronously is reported after createWatcher returns', async () => {
    const events = [];
    const w = createWatcher(h.tmpDir(), {
      onEvent: (e) => events.push(e),
      fsWatch: () => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); },
    }, { gitDir: '.git' });
    assert.deepEqual(events, []);
    await w.ready;
    await settle();
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].kinds, ['error']);
    assert.equal(events[0].error.code, 'ENOSPC');
  });

  test('git rev-parse failing (not a repository) is reported as error and closes the watch', async () => {
    const f = fakeFs();
    const events = [];
    const w = createWatcher(h.tmpDir(), { onEvent: (e) => events.push(e), fsWatch: f.fsWatch });
    await w.ready;
    await settle();
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].kinds, ['error']);
    assert.match(events[0].error.message, /not a git repository/);
    assert.ok(f.watches.every((x) => x.closed));
  });

  test('a deleted root is reported as gone', async () => {
    const s = setup();
    s.fire('a.txt');
    fs.rmSync(s.root, { recursive: true, force: true });
    await s.advance(2000);
    assert.deepEqual(s.events, [{ kinds: ['gone'] }]);
    assert.ok(s.watches[0].closed);
  });

  test('close() clears timers and watchers and is idempotent', async () => {
    const s = setup();
    s.fire('a.txt');
    s.fire('.git/HEAD');
    s.w.close();
    s.w.close();
    s.w.pause();
    s.w.resume();
    assert.equal(s.clock.pending(), 0);
    assert.ok(s.watches[0].closed);
    await s.advance(5000);
    assert.deepEqual(s.events, []);
  });

  test('onEvent is required', () => {
    assert.throws(() => createWatcher(h.tmpDir(), {}), TypeError);
  });
});


// ---------------------------------------------------------------- real fs + git

const WORK = 150;
const REFS = 50;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Real watcher on a real repo; `quiet()` waits for a window without events. */
async function live(dir, o = {}) {
  const events = [];
  const logged = [];
  const w = createWatcher(dir, {
    onEvent: (e) => events.push(e), debounceWork: WORK, debounceRefs: REFS, log: (...a) => logged.push(a), ...o,
  });
  await w.ready;
  await wait(150); // FSEvents may still deliver changes made before the watch started
  events.length = 0;
  const until = async (pred, ms = 3000) => {
    const end = Date.now() + ms;
    while (!pred() && Date.now() < end) await wait(20);
    return pred();
  };
  const kinds = () => new Set(events.flatMap((e) => e.kinds));
  return { w, events, logged, until, kinds, reset: () => { events.length = 0; } };
}

describe('real repository', () => {
  test('edit → status after the debounce; commit → full; tag → refs; stash → stashes', async () => {
    const dir = h.initRepo();
    const l = await live(dir);
    try {
      h.write(dir, 'README.md', 'changed\n');
      await wait(WORK / 2);
      assert.deepEqual(l.events, [], 'not before the debounce');
      assert.ok(await l.until(() => l.kinds().has('status')), JSON.stringify(l.events));
      assert.ok(l.events.some((e) => e.paths && e.paths.includes('README.md')));

      await wait(WORK * 2);
      l.reset();
      h.git(dir, 'commit', '-qam', 'second');
      assert.ok(await l.until(() => l.kinds().has('full')), JSON.stringify(l.events));

      await wait(WORK * 2);
      l.reset();
      h.git(dir, 'tag', 'v1');
      assert.ok(await l.until(() => l.kinds().has('refs')), JSON.stringify(l.events));
      await wait(WORK * 2);
      assert.ok(!l.kinds().has('full'), JSON.stringify(l.events));

      l.reset();
      h.write(dir, 'README.md', 'dirty\n');
      h.git(dir, 'stash', '-q');
      assert.ok(await l.until(() => l.kinds().has('stashes')), JSON.stringify(l.events));
    } finally {
      l.w.close();
    }
  });

  test('changes to ignored files emit nothing', async () => {
    const dir = h.initRepo();
    // ':(glob)…' would be read as pathspec magic (fatal for the whole check) without the './' prefix.
    h.commitFile(dir, '.gitignore', 'ignored.txt\nnode_modules/\n:(glob)noise\n\\[x\\].log\n');
    h.write(dir, 'node_modules/pkg/index.js', 'x');
    const l = await live(dir);
    try {
      h.write(dir, 'ignored.txt', 'noise');
      if (process.platform !== 'win32') h.write(dir, ':(glob)noise', 'x');
      h.write(dir, '[x].log', 'x');
      for (let i = 0; i < 50; i++) h.write(dir, `node_modules/pkg/f${i}.js`, 'x');
      await wait(WORK * 4);
      assert.deepEqual(l.events, []);
      h.write(dir, 'visible.txt', 'x');
      assert.ok(await l.until(() => l.kinds().has('status')), 'a non-ignored file still counts');
    } finally {
      l.w.close();
    }
  });

  test('paused: nothing is emitted; resume emits one batch', async () => {
    const dir = h.initRepo();
    const l = await live(dir);
    try {
      l.w.pause();
      h.write(dir, 'README.md', 'changed\n');
      h.git(dir, 'commit', '-qam', 'while paused');
      h.git(dir, 'tag', 'v2');
      await wait(WORK * 4);
      assert.deepEqual(l.events, []);
      l.w.resume();
      assert.ok(await l.until(() => l.events.length > 0));
      await wait(50);
      assert.deepEqual(l.events, [{ kinds: ['full'] }]);
    } finally {
      l.w.close();
    }
  });

  test('a normal repo sees a linked worktree added, locked and removed -> refs', async () => {
    const main = h.initRepo();
    const wt = path.join(h.tmpDir(), 'wt');
    const l = await live(main);
    try {
      for (const args of [['worktree', 'add', '-q', '--detach', wt], ['worktree', 'lock', wt], ['worktree', 'unlock', wt],
        ['worktree', 'remove', wt]]) {
        l.reset();
        h.git(main, ...args);
        assert.ok(await l.until(() => l.kinds().has('refs')), `${args[1]}: ${JSON.stringify(l.events)}`);
        await wait(WORK * 2);
      }
      assert.deepEqual(l.logged, []);
    } finally {
      l.w.close();
    }
  });

  test('a linked worktree sees a sibling worktree change (refs) while its own HEAD stays full', async () => {
    const main = h.initRepo();
    const me = path.join(h.tmpDir(), 'me');
    const other = path.join(h.tmpDir(), 'other');
    h.git(main, 'worktree', 'add', '-q', '-b', 'me', me);
    h.git(main, 'worktree', 'add', '-q', '-b', 'other', other);
    const l = await live(me);
    try {
      h.git(other, 'switch', '-q', '--detach'); // only worktrees/other/HEAD moves
      assert.ok(await l.until(() => l.kinds().has('refs')), JSON.stringify(l.events));
      await wait(WORK * 2);
      assert.ok(!l.kinds().has('full'), JSON.stringify(l.events));
      l.reset();
      h.git(me, 'switch', '-q', '--detach'); // its own worktrees/me/HEAD
      assert.ok(await l.until(() => l.kinds().has('full')), JSON.stringify(l.events));
    } finally {
      l.w.close();
    }
  });

  test('a linked worktree watches its external gitdir and the common dir', async () => {
    const main = h.initRepo();
    const wt = path.join(h.tmpDir(), 'wt');
    h.git(main, 'worktree', 'add', '-q', '-b', 'side', wt);
    const l = await live(wt);
    try {
      h.git(main, 'tag', 'from-main'); // refs are shared by every worktree
      assert.ok(await l.until(() => l.kinds().has('refs')), JSON.stringify(l.events));
      await wait(WORK * 2);
      l.reset();
      h.write(wt, 'README.md', 'wt edit\n');
      h.git(wt, 'commit', '-qam', 'in worktree');
      assert.ok(await l.until(() => l.kinds().has('full')), JSON.stringify(l.events));
    } finally {
      l.w.close();
    }
  });

  test('deleting the repository emits gone', async () => {
    const dir = h.initRepo();
    const l = await live(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    assert.ok(await l.until(() => l.kinds().has('gone')), JSON.stringify(l.events));
    l.w.close();
  });
  test('object writes (hash-object -w, a fetch) emit nothing', async () => {
    const dir = h.initRepo();
    const l = await live(dir);
    try {
      const blob = path.join(h.tmpDir(), 'blob');
      for (let i = 0; i < 5; i++) {
        fs.writeFileSync(blob, `object ${i} ${Math.random()}`);
        h.git(dir, 'hash-object', '-w', blob);
      }
      await wait(WORK * 4);
      assert.deepEqual(l.events, []);
    } finally {
      l.w.close();
    }
  });

  test('deleting an ignored folder emits nothing (a directory-only pattern)', async () => {
    const dir = h.initRepo();
    h.commitFile(dir, '.gitignore', 'build/\n');
    h.write(dir, 'build/deep/out.o', 'x');
    h.write(dir, 'build/b.o', 'x');
    const l = await live(dir);
    try {
      fs.rmSync(path.join(dir, 'build'), { recursive: true, force: true });
      await wait(WORK * 4);
      assert.deepEqual(l.events, []);
      assert.deepEqual(l.logged, []);
    } finally {
      l.w.close();
    }
  });

  test('a superproject: changes inside a submodule count as a change to its gitlink, never fail the check', async () => {
    const sub = h.initRepo();
    h.commitFile(sub, '.gitignore', 'out/\n');
    const sup = h.initRepo();
    h.commitFile(sup, '.gitignore', 'ignored.txt\n');
    h.git(sup, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'mod');
    h.git(sup, 'commit', '-qm', 'add submodule');
    const l = await live(sup);
    try {
      h.write(sup, 'mod/new.txt', 'x'); // superproject status: mod has untracked content
      h.write(sup, 'ignored.txt', 'x');
      assert.ok(await l.until(() => l.kinds().has('status')), JSON.stringify(l.events));
      await wait(WORK);
      assert.deepEqual(l.events, [{ kinds: ['status'], paths: ['mod'] }]);
      assert.deepEqual(l.logged, [], 'check-ignore did not fail');
      l.reset();
      h.write(sup, 'top.txt', 'x');
      assert.ok(await l.until(() => l.events.length > 0));
      await wait(WORK);
      assert.deepEqual(l.events, [{ kinds: ['status'], paths: ['top.txt'] }], 'the superproject is still filtered');
    } finally {
      l.w.close();
    }
  });
});

// ---------------------------------------------------------------- bare repositories

test('classify / noisyGit: worktrees/ entries count in every repo', () => {
  for (const p of ['.git/worktrees', '.git/worktrees/x', '.git/worktrees/x/HEAD', '.git/worktrees/x/locked', '.git/locked']) {
    assert.equal(classify(p), 'refs', p);
  }
  for (const p of ['.git/worktrees/x/index', '.git/worktrees/x/HEAD.lock', '.git/worktrees/x/logs/HEAD', '.git/worktrees/x/gitdir']) {
    assert.equal(classify(p), null, p);
  }
  assert.equal(noisyGit('worktrees/x'), false);
  assert.equal(noisyGit('worktrees/x/logs'), true);
});

describe('bare repository (option bare)', () => {
  const never = (what) => async () => { throw new Error(`${what} must not run for a bare repo`); };

  test('paths are git paths: HEAD / refs / config classify as usual, the rest is ignored; check-ignore never runs', async () => {
    const s = setup({ bare: true, internal: { gitlinks: never('gitlinks'), ignoredEntries: never('ignoredEntries') } });
    await s.w.ready;
    assert.equal(s.watches.length, 1);
    assert.equal(s.watches[0].base, fs.realpathSync(s.root), 'the git dir itself is the only watch');
    s.fire('refs/heads/feat');
    await s.advance(250);
    assert.deepEqual(s.events, [{ kinds: ['full'] }]);
    s.events.length = 0;
    s.fire('refs/remotes/origin/main');
    s.fire('config');
    s.fire('objects/ab/cdef');
    s.fire('logs/HEAD');
    s.fire('FETCH_HEAD');
    await s.advance(250);
    assert.deepEqual(s.events, [{ kinds: ['refs'] }]);
    s.events.length = 0;
    // A linked worktree's own files: only what the banner shows (the list, locked, its branch).
    for (const p of ['worktrees/main/index', 'worktrees/main/logs/HEAD', 'worktrees/main/ORIG_HEAD', 'worktrees/main/HEAD.lock', 'worktrees/main/rebase-merge/done']) s.fire(p);
    await s.advance(2000);
    assert.deepEqual(s.events, [], 'the rest of worktrees/<name> is ignored');
    for (const p of ['worktrees/main/HEAD', 'worktrees/new', 'worktrees/main/locked', 'worktrees']) {
      s.fire(p);
      await s.advance(250);
      assert.deepEqual(s.events, [{ kinds: ['refs'] }], p);
      s.events.length = 0;
    }
    s.fire('HEAD');
    s.fire('packed-refs.lock');
    await s.advance(250);
    assert.deepEqual(s.events, [{ kinds: ['full'] }]);
    s.events.length = 0;
    s.fire(''); // fs.watch did not say what changed: inside a git dir, assume anything
    s.fire(null);
    await s.advance(2000);
    assert.deepEqual(s.events, [{ kinds: ['full'] }]);
    await s.advance(10000);
    assert.deepEqual(s.checks, [], 'isIgnored never called');
    assert.deepEqual(s.logged, []);
    s.w.close();
  });

  test('Linux: the git dir is watched directly, its noisy parts pruned; nothing is listed', async () => {
    const s = setup({ bare: true, internal: { platform: 'linux', ignoredEntries: never('ignoredEntries') } });
    await s.w.ready;
    assert.equal(s.watches.length, 1);
    const skip = s.watches[0].opts.ignore;
    const n = (p) => p.split('/').join(path.sep);
    for (const p of ['objects', 'objects/ab', 'logs/HEAD', 'logs/refs/heads', 'worktrees/main/logs', 'worktrees/main/index', 'worktrees/main/refs', 'modules', 'lfs']) {
      assert.equal(skip(n(p)), true, p);
    }
    // The linked worktrees stay watched (their list and branches are in the banner).
    for (const p of ['refs', 'refs/heads/main', 'HEAD', 'config', 'logs', 'logs/refs', 'logs/refs/stash', 'packed-refs', 'worktrees', 'worktrees/main', 'worktrees/main/HEAD', 'worktrees/main/locked']) {
      assert.equal(skip(n(p)), false, p);
    }
    assert.deepEqual(s.logged, []);
    s.w.close();
  });

  test('real bare repo: a branch made in a linked worktree -> full; a commit there -> full; a worktree added or switched -> refs', async () => {
    const { bare, wt } = h.bareWithWorktree();
    const l = await live(bare, { bare: true, isIgnored: never('isIgnored') });
    try {
      h.git(bare, 'branch', 'feat', 'main');
      assert.ok(await l.until(() => l.kinds().has('full')), JSON.stringify(l.events));
      l.reset();
      h.commitFile(wt, 'wt.txt', 'x\n'); // moves refs/heads/main in the shared refs
      assert.ok(await l.until(() => l.kinds().has('full')), JSON.stringify(l.events));
      await wait(WORK * 2);
      // A worktree added, and a linked worktree switching branch (only its worktrees/<name>/HEAD moves).
      l.reset();
      h.git(bare, 'worktree', 'add', '-q', '--detach', path.join(path.dirname(bare), 'extra'), 'main');
      assert.ok(await l.until(() => l.kinds().has('refs')), JSON.stringify(l.events));
      await wait(WORK * 2);
      l.reset();
      h.git(wt, 'switch', '-q', '--detach');
      assert.ok(await l.until(() => l.kinds().has('refs')), JSON.stringify(l.events));
      await wait(WORK * 2);
      assert.deepEqual(l.logged, []);
    } finally {
      l.w.close();
    }
  });
});
