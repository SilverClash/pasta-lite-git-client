'use strict';
// Diff view rules (renderer/components/diff-model.js): rows, widths, specs, staging limits and
// the guarded write flow used by every staging action.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./renderer-harness.js');

const D = () => H.loadComponentHelpers().PLDiff;

const line = (type, text, extra = {}) => ({ type, text, ...extra });
const hunk = (header, lines, extra = {}) => ({ header, lines, ...extra });
const file = (hunks, extra = {}) => ({ oldPath: 'a.txt', newPath: 'a.txt', hunks, ...extra });

// ------------------------------------------------------------------ columns

test('columns: tabs expand to 4-column stops, control markers count their width', () => {
  const { columns, ctlLabel } = D();
  assert.equal(columns(''), 0);
  assert.equal(columns('abc'), 3);
  assert.equal(columns('\tx'), 5);
  assert.equal(columns('ab\tx'), 5);
  assert.equal(columns('abcd\tx'), 9);
  const marker = ctlLabel('\u202e').length;
  assert.equal(columns('a\u202eb'), 2 + marker);
  assert.equal(columns('\u200b\u200b'), 2 * marker);
});

// ------------------------------------------------------------------ flatten

test('flatten: rows with selection indices, eof markers, stats and blocked hunks', () => {
  const { flatten } = D();
  const f = file([
    hunk('@@ -1,2 +1,2 @@', [line('context', 'a', { oldNo: 1, newNo: 1 }), line('del', 'b', { oldNo: 2 }), line('add', 'B', { newNo: 2, noNewlineAtEof: true })]),
    hunk('@@ -10 +10 @@', [line('add', 'x'.repeat(50), { newNo: 120, clipped: true })], { truncated: true }),
  ]);
  const flat = flatten([f], null);
  assert.deepEqual(flat.rows.map((r) => r.t), ['hunk', 'line', 'line', 'line', 'eof', 'hunk', 'line']);
  assert.deepEqual(flat.hunkRows, [0, 5]);
  assert.deepEqual(flat.rows.filter((r) => r.t === 'line').map((r) => [r.s, r.h, r.li]), [[0, 0, 0], [0, 0, 1], [0, 0, 2], [0, 1, 0]]);
  assert.equal(flat.adds, 2);
  assert.equal(flat.dels, 1);
  assert.equal(flat.maxNo, 120);
  assert.equal(flat.maxCols, 50 + 18);
  assert.deepEqual(flat.blocked, [false, true]);
});

test('flatten: several sections get headers and notes; conflicts use prefix rows', () => {
  const { flatten } = D();
  const flat = flatten([
    file([], { isDeleted: true, oldMode: '120000' }),
    file([hunk('@@ -0,0 +1 @@', [line('add', 'x', { newNo: 1 })])], { isNew: true, newMode: '100644' }),
  ], null);
  assert.deepEqual(flat.rows.map((r) => r.t), ['section', 'note', 'section', 'hunk', 'line']);
  assert.match(flat.rows[0].label, /^Deleted symlink 120000/);
  assert.equal(flat.rows[1].text, 'Empty file deleted');
  assert.equal(flat.blocked.length, 0, 'only section 0 hunks are tracked');
  const c = flatten([], { hunks: [hunk('@@@ -1 -1 +1 @@@', [{ prefix: '+-', text: 'x' }, { prefix: '  ', text: '=======' }])] });
  assert.deepEqual(c.rows.map((r) => r.t), ['hunk', 'cline', 'cline']);
  assert.equal(c.prefixW, 2);
  assert.equal(c.adds, 1);
  assert.equal(c.dels, 1);
});

// ------------------------------------------------------------------ specs

test('sameSpec: kind, file, side and commit; untracked / orig changes are the same file', () => {
  const { sameSpec } = D();
  const w = { kind: 'workdir', file: 'a', staged: false, untracked: true };
  assert.equal(sameSpec(w, { ...w }), true);
  assert.equal(sameSpec(w, { ...w, untracked: false }), true, 'untracked → tracked after a partial stage');
  assert.equal(sameSpec({ ...w, staged: true, orig: 'o' }, { ...w, staged: true, orig: 'p' }), true);
  assert.equal(sameSpec(w, { ...w, staged: true }), false);
  assert.equal(sameSpec(w, { ...w, file: 'b' }), false);
  assert.equal(sameSpec({ kind: 'commit', sha: '1', file: 'a' }, { kind: 'commit', sha: '2', file: 'a' }), false);
  assert.equal(sameSpec({ kind: 'commit', sha: '1', file: 'a' }, w), false);
  assert.equal(sameSpec(null, w), false);
  assert.equal(sameSpec(w, undefined), false);
});

test('specTitle: rename from the diff, then from the spec, then the file', () => {
  const { specTitle } = D();
  assert.deepEqual(specTitle({ file: 'n' }, { isRename: true, oldPath: 'o', newPath: 'n' }), { old: 'o', path: 'n' });
  assert.deepEqual(specTitle({ file: 'n', orig: 'o' }, { newPath: 'n' }), { old: 'o', path: 'n' });
  assert.deepEqual(specTitle({ file: 'n' }, { oldPath: 'n', newPath: null }), { old: null, path: 'n' });
  assert.deepEqual(specTitle({ file: 'n' }, null), { old: null, path: 'n' });
});

test('hunkAt: last hunk header at or above a row', () => {
  const { hunkAt } = D();
  assert.equal(hunkAt([], 5), -1);
  assert.equal(hunkAt([3, 10, 20], 0), -1);
  assert.equal(hunkAt([3, 10, 20], 3), 0);
  assert.equal(hunkAt([3, 10, 20], 19), 1);
  assert.equal(hunkAt([3, 10, 20], 500), 2);
  assert.equal(hunkAt([0], 0), 0);
});

test('origEntry: staged entries with an old path only', () => {
  const { origEntry } = D();
  const st = H.status({ staged: [{ path: 'n', status: 'R', orig: 'o' }, { path: 'c', status: 'C', orig: 's' }, { path: 'm', status: 'M' }], unstaged: [{ path: 'u', status: 'R', orig: 'x' }] });
  const spec = (file, staged = true) => ({ kind: 'workdir', file, staged });
  assert.equal(origEntry(spec('n'), st).orig, 'o');
  assert.equal(origEntry(spec('c'), st).status, 'C');
  assert.equal(origEntry(spec('m'), st), null);
  assert.equal(origEntry(spec('u', false), st), null, 'unstaged side is not looked at');
  assert.equal(origEntry(spec('n'), null), null);
});

// ------------------------------------------------------------------ staging limits

const data = (sections, extra = {}) => ({ file: sections[0] || null, sections, fingerprint: 'fp1', truncated: false, conflict: null, ...extra });
const text = () => file([hunk('@@ -1 +1 @@', [line('del', 'a', { oldNo: 1 }), line('add', 'b', { newNo: 1 })])], { oldMode: '100644', newMode: '100644' });
const unstagedSpec = { kind: 'workdir', file: 'a.txt', staged: false };
const stagedSpec = { kind: 'workdir', file: 'a.txt', staged: true };

test('hunkDataOk: a fingerprinted regular text file on either side', () => {
  const { hunkDataOk, actMode } = D();
  const st = H.status({ unstaged: [{ path: 'a.txt', status: 'M' }], staged: [{ path: 'a.txt', status: 'M' }] });
  assert.equal(hunkDataOk(unstagedSpec, data([text()]), st), true);
  assert.equal(hunkDataOk(stagedSpec, data([text()]), st), true);
  assert.equal(actMode(unstagedSpec, data([text()])), 'unstaged');
  assert.equal(actMode(stagedSpec, data([text()])), 'staged');
  assert.equal(actMode({ kind: 'commit', sha: '1', file: 'a.txt' }, data([text()])), null);
});

test('hunkDataOk: refused without a fingerprint, for symlinks, submodules, type changes, conflicts and staged renames', () => {
  const { hunkDataOk, stagingNote } = D();
  const st = H.status({ unstaged: [{ path: 'a.txt', status: 'M' }] });
  const cases = [
    ['no fingerprint', unstagedSpec, data([text()], { fingerprint: null }), st, /isn't available/],
    ['symlink', unstagedSpec, data([{ ...text(), newMode: '120000', oldMode: '120000' }]), st, /Symlink/],
    ['submodule', unstagedSpec, data([{ ...text(), newMode: '160000' }]), st, /Symlink or submodule/],
    ['two sections', unstagedSpec, data([text(), text()]), st, /Type change/],
    ['status T', unstagedSpec, data([text()]), H.status({ unstaged: [{ path: 'a.txt', status: 'T' }] }), /Type change/],
    ['staged rename', stagedSpec, data([text()]), H.status({ staged: [{ path: 'a.txt', status: 'R', orig: 'old.txt' }] }), /Renamed file/],
    ['staged copy', stagedSpec, data([text()]), H.status({ staged: [{ path: 'a.txt', status: 'C', orig: 'src.txt' }] }), /Renamed file/],
    ['truncated, no fingerprint', unstagedSpec, data([text()], { fingerprint: null, truncated: true }), st, /too large/],
  ];
  for (const [name, spec, d, status, note] of cases) {
    assert.equal(hunkDataOk(spec, d, status), false, name);
    assert.match(stagingNote(spec, d, status), note, name);
  }
  assert.equal(hunkDataOk(unstagedSpec, data([text()], { conflict: { hunks: [] } }), st), false, 'conflict');
  assert.equal(stagingNote(unstagedSpec, data([text()], { conflict: { hunks: [] } }), st), null, 'conflicts have their own banner');
  assert.equal(stagingNote(unstagedSpec, data([text()]), st), null, 'no note when staging works');
  assert.match(stagingNote(stagedSpec, data([{ ...text(), isBinary: true, hunks: [] }], { fingerprint: null }), st), /Binary file — stage it as a whole with Unstage File/);
});

test('emptyText / stagingNote: a binary file keeps its message and note (the image preview replaces only the body)', () => {
  const { emptyText, stagingNote } = D();
  const bin = { ...file([]), isBinary: true, oldMode: '100644', newMode: '100644', oldPath: 'a.png', newPath: 'a.png' };
  assert.equal(emptyText(bin), 'Binary file — no preview');
  const st = H.status({ unstaged: [{ path: 'a.png', status: 'M' }] });
  assert.equal(stagingNote({ ...unstagedSpec, file: 'a.png' }, data([bin], { fingerprint: null }), st), 'Binary file — stage it as a whole with Stage File.');
});

test('isPickable / nextPickable: add and del lines of complete section-0 hunks only', () => {
  const { flatten, isPickable, nextPickable } = D();
  const flat = flatten([file([
    hunk('@@ 1 @@', [line('context', 'c'), line('add', 'a'), line('context', 'c'), line('del', 'd')]),
    hunk('@@ 2 @@', [line('add', 'x')], { truncated: true }),
    hunk('@@ 3 @@', [line('add', 'y')]),
  ])], null);
  // rows: 0 hunk, 1 ctx, 2 add, 3 ctx, 4 del, 5 hunk, 6 add(blocked), 7 hunk, 8 add
  assert.deepEqual(flat.rows.map((_, i) => isPickable(flat, i, true)), [false, false, true, false, true, false, false, false, true]);
  assert.equal(isPickable(flat, 2, false), false, 'nothing is pickable when the diff cannot be staged by line');
  assert.equal(isPickable(flat, 99, true), false);
  assert.equal(nextPickable(flat, -1, 1, true), 2);
  assert.equal(nextPickable(flat, 2, 1, true), 4);
  assert.equal(nextPickable(flat, 4, 1, true), 8, 'skips the blocked hunk');
  assert.equal(nextPickable(flat, 8, 1, true), -1);
  assert.equal(nextPickable(flat, 8, -1, true), 4);
  assert.equal(nextPickable(flat, 2, -1, true), -1);
  assert.equal(nextPickable(flat, -1, 1, false), -1);
});

test('selectionPayload: lines grouped per hunk, in file order', () => {
  const { flatten, selectionPayload } = D();
  const flat = flatten([file([
    hunk('@@ 1 @@', [line('add', 'a'), line('del', 'b'), line('add', 'c')]),
    hunk('@@ 2 @@', [line('context', 'x'), line('add', 'y')]),
  ])], null);
  // rows: 0 hunk, 1 a(0), 2 b(1), 3 c(2), 4 hunk, 5 x(0), 6 y(1)
  assert.deepEqual(selectionPayload(new Set([6, 3, 1]), flat.rows), [{ hunk: 0, lines: [0, 2] }, { hunk: 1, lines: [1] }]);
  assert.deepEqual(selectionPayload(new Set(), flat.rows), []);
  assert.deepEqual(D().SELECTION_OPS, { stage: 'stageSelection', unstage: 'unstageSelection', discard: 'discardSelection' });
});

// ------------------------------------------------------------------ write flow

/** Recording io for writeFlow; `over` replaces single hooks. */
function fakeIo(over = {}) {
  const log = [];
  const io = {
    log,
    isOff: () => false,
    begin: () => log.push('begin'),
    confirm: async () => { log.push('confirm'); return true; },
    isCurrent: () => true,
    isBusy: () => false,
    write: async () => { log.push('write'); },
    hold: () => log.push('hold'),
    end: () => log.push('end'),
    stale: () => log.push('stale'),
    fail: (e) => log.push(`fail:${e.message}`),
    changed: () => log.push('changed'),
    ...over,
  };
  return io;
}

test('writeFlow: success holds the in-flight state instead of ending it', async () => {
  const { writeFlow } = D();
  const io = fakeIo();
  assert.equal(await writeFlow(io, { confirm: { title: 'x' } }), 'ok');
  assert.deepEqual(io.log, ['begin', 'confirm', 'write', 'hold']);
  const plain = fakeIo();
  assert.equal(await writeFlow(plain), 'ok');
  assert.deepEqual(plain.log, ['begin', 'write', 'hold'], 'no confirm when none is asked for');
});

test('writeFlow: nothing starts while a write is in flight', async () => {
  const { writeFlow } = D();
  const io = fakeIo({ isOff: () => true });
  assert.equal(await writeFlow(io, { confirm: {} }), 'busy');
  assert.deepEqual(io.log, []);
});

test('writeFlow: cancelled confirm sends nothing and ends the in-flight state', async () => {
  const { writeFlow } = D();
  const io = fakeIo({ confirm: async () => { io.log.push('confirm'); return false; } });
  assert.equal(await writeFlow(io, { confirm: {} }), 'cancelled');
  assert.deepEqual(io.log, ['begin', 'confirm', 'end']);
});

test('writeFlow: the diff changed or another write started during the confirm', async () => {
  const { writeFlow } = D();
  const moved = fakeIo({ isCurrent: () => false });
  assert.equal(await writeFlow(moved, { confirm: {} }), 'moved');
  assert.deepEqual(moved.log, ['begin', 'confirm', 'end']);
  const busy = fakeIo({ isBusy: () => true });
  assert.equal(await writeFlow(busy, { confirm: {} }), 'moved');
  assert.deepEqual(busy.log, ['begin', 'confirm', 'end']);
});

test('writeFlow: a failed freshness check reports "changed" and sends nothing', async () => {
  const { writeFlow } = D();
  const io = fakeIo();
  assert.equal(await writeFlow(io, { confirm: {}, check: () => false }), 'changed');
  assert.deepEqual(io.log, ['begin', 'confirm', 'changed', 'end']);
  const ok = fakeIo();
  assert.equal(await writeFlow(ok, { check: () => true }), 'ok');
  assert.deepEqual(ok.log, ['begin', 'write', 'hold']);
});

test('writeFlow: stale and other errors end the in-flight state', async () => {
  const { writeFlow } = D();
  const stale = fakeIo({ write: async () => { throw Object.assign(new Error('changed'), { kind: 'stale' }); } });
  assert.equal(await writeFlow(stale), 'stale');
  assert.deepEqual(stale.log, ['begin', 'stale', 'end']);
  const boom = fakeIo({ write: async () => { throw Object.assign(new Error('symlinked file'), { kind: 'symlink' }); } });
  assert.equal(await writeFlow(boom), 'error');
  assert.deepEqual(boom.log, ['begin', 'fail:symlinked file', 'end']);
  const confirmFails = fakeIo({ confirm: async () => { throw new Error('dialog'); } });
  assert.equal(await writeFlow(confirmFails, { confirm: {} }), 'error');
  assert.deepEqual(confirmFails.log, ['begin', 'fail:dialog', 'end']);
});

test('writeFlow: the confirm option is passed through to io.confirm', async () => {
  const { writeFlow } = D();
  let got = null;
  const fn = () => Promise.resolve(true);
  const io = fakeIo({ confirm: async (c) => { got = c; return true; } });
  await writeFlow(io, { confirm: fn });
  assert.equal(got, fn);
});

// ------------------------------------------------------------------ stylesheet

test('css: hunk action buttons paint above the sticky gutter (long hunk headers never cover Discard Hunk)', () => {
  // M7: a hunk header whose function context was wider than the space left of the buttons was
  // painted over "Discard Hunk" (the header lives in the sticky .dv-gutter, z-index 1), so the
  // button could not be clicked.
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'renderer', 'components', 'diff-view.css'), 'utf8');
  const z = (sel) => {
    const re = new RegExp(`(^|\\n)${sel.replace(/[.]/g, '\\.')}\\s*\\{([^}]*)\\}`, 'g');
    let v = null;
    for (const m of css.matchAll(re)) {
      const d = /z-index:\s*(\d+)/.exec(m[2]);
      if (d) v = Number(d[1]);
    }
    return v;
  };
  assert.equal(z('.dv-gutter'), 1);
  assert.ok(z('.dv-hunk-actions') > z('.dv-gutter'), `.dv-hunk-actions z-index ${z('.dv-hunk-actions')}`);
});
