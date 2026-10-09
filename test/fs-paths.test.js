'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir } = require('./helpers');
const {
  realPathSync, realPathOf, resetRealPathOf, isAtOrUnder, homeShort, samePath, nativePath, _internal: { REALPATH_TIMEOUT_MS, MAX_PARALLEL },
} = require('../src/fs-paths');

/** A real folder, a symlink to it and a file, under one temp folder. */
function layout() {
  const base = fs.realpathSync.native(tmpDir());
  const dir = path.join(base, 'dir');
  fs.mkdirSync(dir);
  const link = path.join(base, 'link');
  fs.symlinkSync(dir, link);
  const file = path.join(base, 'file');
  fs.writeFileSync(file, 'x');
  return { base, dir, link, file };
}

test('realPathSync: symlinks resolved; a missing path is path.resolve', () => {
  const { base, dir, link } = layout();
  assert.equal(realPathSync(link), dir);
  assert.equal(realPathSync(dir), dir);
  assert.equal(realPathSync(path.join(link, 'missing', '..', 'x')), path.join(link, 'x'), 'missing: resolved, not followed');
  assert.equal(realPathSync(path.relative(process.cwd(), path.join(base, 'nope'))), path.join(base, 'nope'));
});

test('realPathOf: {real, missing}; missing only when the path is not there', async () => {
  const { base, dir, link, file } = layout();
  assert.deepEqual(await realPathOf(link), { real: dir, missing: false });
  assert.deepEqual(await realPathOf(dir), { real: dir, missing: false });
  assert.deepEqual(await realPathOf(path.join(base, 'gone')), { real: path.join(base, 'gone'), missing: true }, 'ENOENT');
  assert.deepEqual(await realPathOf(path.join(file, 'sub')), { real: path.join(file, 'sub'), missing: true }, 'ENOTDIR');
  fs.symlinkSync(path.join(base, 'gone'), path.join(base, 'dangling'));
  assert.deepEqual(await realPathOf(path.join(base, 'dangling')), { real: path.join(base, 'dangling'), missing: true }, 'a dangling link');
  assert.equal(REALPATH_TIMEOUT_MS > 0, true);
});

/**
 * Replace fs.promises.realpath for one test with `fake(p, {hang, saved})`; returns the calls counted
 * by path, plus release(): hung calls answer then (and after the test at the latest).
 */
function stubRealpath(t, fake) {
  const saved = fs.promises.realpath;
  const calls = new Map();
  let release;
  const released = new Promise((r) => { release = r; });
  const hang = (p) => released.then(() => saved(p));
  t.after(() => { fs.promises.realpath = saved; release(); resetRealPathOf(); });
  fs.promises.realpath = (p) => {
    calls.set(p, (calls.get(p) || 0) + 1);
    return fake(p, { hang, saved });
  };
  calls.release = release;
  return calls;
}

test('realPathOf: an answer past the timeout (a hung mount) is the resolved path, not missing; other errors too', async (t) => {
  const { dir, base } = layout();
  const denied = path.join(base, 'denied');
  stubRealpath(t, (p, { hang }) => (p === dir ? hang(p) : Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' }))));
  const t0 = Date.now();
  assert.deepEqual(await realPathOf(dir, { timeout: 50 }), { real: dir, missing: false });
  assert.ok(Date.now() - t0 < 2000, 'bounded by the timeout');
  assert.deepEqual(await realPathOf(denied), { real: denied, missing: false }, 'unknown is not gone');
});

test('realPathOf: one realpath per path at a time (shared), a slow path is not asked again for a while', async (t) => {
  const { dir, link } = layout();
  const calls = stubRealpath(t, (p, { hang, saved }) => (p === link ? hang(p) : saved(p)));
  const answers = await Promise.all([1, 2, 3].map(() => realPathOf(link, { timeout: 50 })));
  for (const a of answers) assert.deepEqual(a, { real: link, missing: false });
  assert.equal(calls.get(link), 1, 'three callers, one realpath');
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now();
    assert.deepEqual(await realPathOf(link, { timeout: 1000 }), { real: link, missing: false });
    assert.ok(Date.now() - t0 < 500, 'answered at once: remembered as slow');
  }
  assert.equal(calls.get(link), 1, 'never asked again');
  assert.deepEqual(await realPathOf(dir), { real: dir, missing: false }, 'another path is still answered');
  resetRealPathOf();
  assert.deepEqual(await realPathOf(link, { timeout: 50 }), { real: link, missing: false });
  assert.equal(calls.get(link), 1, 'its realpath still runs: shared, not started again');
});

test('realPathOf: at most MAX_PARALLEL realpaths run at once; the rest wait their turn', async (t) => {
  const { base } = layout();
  const paths = Array.from({ length: 6 }, (_, i) => path.join(base, `p${i}`));
  let now = 0;
  let peak = 0;
  stubRealpath(t, async (p) => {
    peak = Math.max(peak, ++now);
    await new Promise((r) => setTimeout(r, 30));
    now--;
    return p;
  });
  const res = await Promise.all(paths.map((p) => realPathOf(p)));
  assert.deepEqual(res, paths.map((p) => ({ real: p, missing: false })));
  assert.equal(peak, MAX_PARALLEL);
  assert.ok(MAX_PARALLEL < 4, 'leaves libuv\'s default pool threads for the rest of main');
});

test('realPathOf: hung paths hold at most MAX_PARALLEL threads; a wait for a slot that times out is not remembered as slow', async (t) => {
  const { base, dir, link } = layout();
  const hung = Array.from({ length: 3 }, (_, i) => path.join(base, `hung${i}`));
  const calls = stubRealpath(t, (p, { hang, saved }) => (hung.includes(p) ? hang(p) : saved(p)));
  await Promise.all(hung.map((p) => realPathOf(p, { timeout: 50 })));
  assert.deepEqual(hung.map((p) => calls.get(p) || 0), [1, 1, 0], 'the third waits: no thread for it');
  // Every slot is held: a healthy path waits too and times out (unknown: its own spelling).
  assert.deepEqual(await realPathOf(link, { timeout: 50 }), { real: link, missing: false });
  assert.equal(calls.get(link) || 0, 0);
  calls.release(); // the mount answers: the slots free up
  assert.deepEqual(await realPathOf(link), { real: dir, missing: false }, 'not remembered as slow: resolved now');
});

test('isAtOrUnder: the folder itself or a path inside it, never a sibling with the same prefix', () => {
  assert.equal(isAtOrUnder('/w/a', '/w/a'), true);
  assert.equal(isAtOrUnder('/w/a/sub/x', '/w/a'), true);
  assert.equal(isAtOrUnder('/w/ab', '/w/a'), false);
  assert.equal(isAtOrUnder('/w', '/w/a'), false);
  assert.equal(isAtOrUnder('/w/a', '/'), true, 'the root folder');
  assert.equal(isAtOrUnder('/w/A', '/w/a', { platform: 'linux' }), false, 'case matters off Windows');
});

test('isAtOrUnder on Windows: any case and either separator, still never a same-prefix sibling', () => {
  const win = { platform: 'win32' };
  assert.equal(isAtOrUnder('C:\\Repo', 'c:\\repo', win), true);
  assert.equal(isAtOrUnder('c:\\REPO\\Sub\\x', 'C:\\Repo', win), true);
  assert.equal(isAtOrUnder('C:/Repo/sub', 'C:\\Repo\\', win), true, "git's forward slashes");
  assert.equal(isAtOrUnder('C:\\Foobar', 'C:\\foo', win), false);
  assert.equal(isAtOrUnder('C:\\FOOBAR\\x', 'c:\\foo', win), false);
  assert.equal(isAtOrUnder('C:\\', 'C:\\foo', win), false);
  assert.equal(isAtOrUnder('D:\\foo', 'C:\\foo', win), false);
  assert.equal(isAtOrUnder('C:\\x', 'C:\\', win), true, 'the drive root');
  assert.equal(isAtOrUnder('\\\\srv\\Share\\r', '\\\\SRV\\share', win), true, 'a UNC share');
  // Only ASCII folds: Windows' case table is not JS's (U+212A KELVIN SIGN lowercases to 'k' in JS).
  assert.equal(isAtOrUnder('C:\\wor\u212A\\x', 'C:\\work', win), false);
  assert.equal(isAtOrUnder('C:\\Straße\\x', 'C:\\STRASSE', win), false);
});

test('isAtOrUnder {fold: false}: separators still either, the case exact (two canonical paths)', () => {
  const exact = { platform: 'win32', fold: false };
  assert.equal(isAtOrUnder('C:\\repo\\x', 'C:\\repo', exact), true);
  assert.equal(isAtOrUnder('C:/repo/x', 'C:\\repo\\', exact), true, "'/' or '\\'");
  assert.equal(isAtOrUnder('C:\\Repo\\x', 'C:\\repo', exact), false, 'a case-sensitive NTFS folder: another folder');
  assert.equal(isAtOrUnder('C:\\Repo', 'C:\\repo', exact), false);
  assert.equal(isAtOrUnder('C:\\Repo\\x', 'C:\\repo', { platform: 'win32' }), true, 'folding is the default');
  assert.equal(isAtOrUnder('/w/a/x', '/w/a', { platform: 'linux', fold: false }), true);
  assert.equal(isAtOrUnder('/w/A/x', '/w/a', { platform: 'linux', fold: true }), false, 'POSIX never folds');
});

test('homeShort: the home folder as ~, at a folder boundary only; POSIX keeps the case', () => {
  const mac = { platform: 'darwin' };
  assert.equal(homeShort('/Users/ada/src/x', '/Users/ada', mac), '~/src/x');
  assert.equal(homeShort('/Users/ada', '/Users/ada', mac), '~');
  assert.equal(homeShort('/srv/me/x', '/srv/me/', mac), '~/x', "a home with a trailing '/'");
  assert.equal(homeShort('/srv/meme/x', '/srv/me', mac), '/srv/meme/x');
  assert.equal(homeShort('/srv/ME/x', '/srv/me', mac), '/srv/ME/x');
  assert.equal(homeShort('/x', '/', mac), '/x', "no home name: '/' is not shortened");
  assert.equal(homeShort('/x', '', mac), '/x');
  assert.equal(homeShort('', '/x', mac), '');
  assert.equal(homeShort('/h\\x', '/h', { platform: 'linux' }), '/h\\x', "'\\' is a name character on POSIX, not a separator");
  assert.equal(homeShort('/h\\/x', '/h\\', { platform: 'linux' }), '~/x', "a home named 'h\\' keeps its '\\'");
});

test('homeShort on Windows: any case and either separator, ASCII only, never a same-prefix sibling', () => {
  const win = { platform: 'win32' };
  assert.equal(homeShort('c:\\users\\Ada\\src\\x', 'C:\\Users\\ada', win), '~\\src\\x');
  assert.equal(homeShort('C:\\USERS\\ADA', 'C:\\Users\\ada\\', win), '~');
  assert.equal(homeShort('C:/Users/ada/src', 'C:\\Users\\ada', win), '~/src', "git's forward slashes: the rest keeps them");
  assert.equal(homeShort('C:\\Users\\adam\\x', 'C:\\Users\\ada', win), 'C:\\Users\\adam\\x');
  assert.equal(homeShort('D:\\Users\\ada\\x', 'C:\\Users\\ada', win), 'D:\\Users\\ada\\x');
  assert.equal(homeShort('\\\\SRV\\home\\ada\\r', '\\\\srv\\home\\ada', win), '~\\r', 'a UNC home');
  assert.equal(homeShort('C:\\Users\\wor\u212A\\x', 'C:\\Users\\work', win), 'C:\\Users\\wor\u212A\\x', 'only ASCII folds');
  assert.equal(homeShort('C:\\x', 'C:\\', win), 'C:\\x', 'a drive root is no home');
});

test("nativePath: git's forward-slash Windows paths in path.resolve's spelling; elsewhere unchanged", () => {
  const win = { platform: 'win32' };
  assert.equal(nativePath('C:/Users/ada/repo', win), 'C:\\Users\\ada\\repo');
  assert.equal(nativePath('C:/Users/ada/repo/', win), 'C:\\Users\\ada\\repo', 'no trailing separator');
  assert.equal(nativePath('C:/Users/ada/repo', win), path.win32.resolve('C:\\Users\\ada\\repo'));
  assert.equal(nativePath('c:/Users/Ada/Repo', win), 'c:\\Users\\Ada\\Repo', 'the case is kept');
  assert.equal(nativePath('//srv/share/r', win), '\\\\srv\\share\\r', 'a UNC path');
  assert.equal(nativePath('C:/', win), 'C:\\');
  assert.equal(nativePath('.git', win), '.git', 'a relative path is left to its caller');
  assert.equal(nativePath('', win), '');
  assert.equal(nativePath('/x/y/', { platform: 'linux' }), '/x/y/');
  assert.equal(nativePath('C:/x', { platform: 'darwin' }), 'C:/x');
});

test('samePath: exact off Windows; on Windows any case and either separator, ASCII only', () => {
  const win = { platform: 'win32' };
  assert.equal(samePath('C:\\Repo', 'c:/repo', win), true);
  assert.equal(samePath('C:\\Repo', 'C:\\Repo2', win), false);
  assert.equal(samePath('C:\\wor\u212A', 'C:\\work', win), false);
  assert.equal(samePath('/w/A', '/w/a', { platform: 'darwin' }), false);
  assert.equal(samePath('/w/a', '/w/a', { platform: 'linux' }), true);
});
