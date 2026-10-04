'use strict';
// Renderer store (renderer/store.js): refresh coalescing, paging races, selection, diffs, rows.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./renderer-harness.js');

const { flush, chain, commit, status, refs, repoData, loadedStore, isRefreshLog } = H;

/**
 * Settle the oldest pending refresh with `data`. A refresh after the first load reads status, refs,
 * stashes and undoState first and only then asks for the log (when a tip moved), so the log is
 * answered once it is requested; returns whether it was. (Works for the first load's parallel batch too.)
 */
async function answerRefresh(api, data, { rejectUndo, rejectStashes } = {}) {
  const logNow = api.pending('log', isRefreshLog)[0];
  api.take('status').resolve(data.status);
  api.take('refs').resolve(data.refs);
  const st = api.take('stashes');
  if (rejectStashes) st.reject(rejectStashes);
  else st.resolve(data.stashes);
  const u = api.take('undoState');
  if (rejectUndo) u.reject(rejectUndo);
  else u.resolve(data.undoState);
  await flush();
  const log = logNow || api.pending('log', isRefreshLog)[0];
  if (log) {
    log.resolve(data.log);
    await flush();
  }
  return !!log;
}

const isMoreLog = (c) => c.op === 'log' && !!(c.args[0] && c.args[0].tips);
const hashes = (store) => store.state.commits.map((c) => c.hash);
const rowKeys = (store) => store.state.rows.map((r) => (r.kind === 'wip' ? 'WIP' : r.commit.hash));

// ------------------------------------------------------------------ 1. refresh coalescing

test('overlapping refreshes coalesce into one re-run and the newest data wins', async () => {
  const old = chain(['b', 'a']);
  const { api, store } = await loadedStore(repoData({ commits: old }));
  const before = api.count('status');

  const pA = store.actions.refresh();
  await flush(1);
  assert.equal(api.count('status'), before + 1, 'refresh A started');
  const pB = store.actions.refresh();
  const pC = store.actions.refresh();
  await flush(1);
  assert.equal(api.count('status'), before + 1, 'B and C wait for A instead of running in parallel');

  // A answers with the old data; exactly one re-run follows.
  await answerRefresh(api, repoData({ commits: old }));
  assert.equal(api.count('status'), before + 2, 'one coalesced re-run');
  assert.deepEqual(hashes(store), ['b', 'a']);

  const fresh = chain(['c', 'b', 'a']);
  await answerRefresh(api, repoData({ commits: fresh }));
  await Promise.all([pA, pB, pC]);
  assert.deepEqual(hashes(store), ['c', 'b', 'a'], 'final state reflects the last data');
  assert.equal(api.count('status'), before + 2, 'no further runs');
  assert.equal(store.state.status.oid, 'c');

  // After settling, a new refresh starts a new run.
  store.actions.refresh();
  await flush(1);
  assert.equal(api.count('status'), before + 3);
});

test('a refresh started for the old repo never lands after loadRepo switched repos', async () => {
  const { api, store } = await loadedStore(repoData({ commits: chain(['b', 'a']) }));
  store.actions.refresh(); // old-repo refresh in flight
  await flush(1);
  const pLoad = store.actions.loadRepo({ root: '/other', name: 'other' });
  await flush(1);
  assert.equal(api.pending('status').length, 2, 'new repo load does not wait for the old refresh');
  // New repo answers first, then the stale old-repo refresh.
  const calls = api.pending('status');
  const newData = repoData({ commits: chain(['z']) });
  const oldData = repoData({ commits: chain(['old2', 'old1']) });
  // answer the NEW batch (the last pending of each op; the old refresh hasn't asked for its log yet)
  for (const [op, v] of [['status', newData.status], ['refs', newData.refs], ['stashes', newData.stashes], ['log', newData.log], ['undoState', newData.undoState]]) {
    const list = api.pending(op, op === 'log' ? isRefreshLog : undefined);
    list[list.length - 1].resolve(v);
  }
  await flush();
  await pLoad;
  assert.deepEqual(hashes(store), ['z']);
  await answerRefresh(api, oldData);
  assert.deepEqual(hashes(store), ['z'], 'stale old-repo result dropped');
  assert.equal(store.state.repo.root, '/other');
  assert.ok(calls.length);
});

// ------------------------------------------------------------------ 2. loadMore vs refresh

function pagedData(commits, next) {
  return repoData({ commits, hasMore: true, next });
}

test('loadMore response is dropped when a refresh replaced the history meanwhile', async () => {
  const oldNext = { tips: ['old'], skip: 2 };
  const { api, store } = await loadedStore(pagedData(chain(['b', 'a']), oldNext));
  const pMore = store.actions.loadMore();
  await flush(1);
  const more = api.take('log', isMoreLog);
  assert.deepEqual(more.args[0], { limit: 200, tips: ['old'], skip: 2 });

  store.actions.refresh();
  await flush(1);
  const newNext = { tips: ['new'], skip: 3 };
  await answerRefresh(api, pagedData(chain(['c', 'b', 'a']), newNext));
  assert.deepEqual(hashes(store), ['c', 'b', 'a']);

  more.resolve({ commits: [commit('stale1', ['stale0']), commit('stale0')], hasMore: false, next: null });
  await pMore;
  await flush();
  assert.deepEqual(hashes(store), ['c', 'b', 'a'], 'stale page dropped');
  assert.equal(store.state.next, newNext, "next is the refresh's next");
  assert.equal(store.state.hasMore, true);
});

test('loadMore appends a page (de-duplicated) and concurrent calls share one invoke', async () => {
  const next1 = { tips: ['t'], skip: 2 };
  const { api, store } = await loadedStore(pagedData(chain(['b', 'a']), next1));
  const p1 = store.actions.loadMore();
  const p2 = store.actions.loadMore();
  const p3 = store.actions.loadMore();
  await flush(1);
  assert.equal(api.pending('log', isMoreLog).length, 1, 'one invoke shared');
  const next2 = { tips: ['u'], skip: 4 };
  api.take('log', isMoreLog).resolve({ commits: [commit('a'), commit('x', ['y']), commit('y')], hasMore: true, next: next2 });
  await Promise.all([p1, p2, p3]);
  assert.deepEqual(hashes(store), ['b', 'a', 'x', 'y']);
  assert.equal(store.state.next, next2);
  assert.equal(store.state.rows.length, 4);
  assert.equal(store.state.graph.rows.length, 4);

  // settled: the next call issues a new invoke with the new cursor
  store.actions.loadMore();
  await flush(1);
  assert.deepEqual(api.take('log', isMoreLog).args[0], { limit: 200, tips: ['u'], skip: 4 });
});

test('loadMore after a repo switch issues a new invoke; the old page is dropped', async () => {
  const { api, store } = await loadedStore(pagedData(chain(['b', 'a']), { tips: ['o'], skip: 2 }));
  const pOld = store.actions.loadMore();
  await flush(1);
  const oldMore = api.take('log', isMoreLog);

  const pLoad = store.actions.loadRepo({ root: '/two', name: 'two' });
  await flush(1);
  const next2 = { tips: ['n'], skip: 1 };
  await answerRefresh(api, pagedData(chain(['n1']), next2));
  await pLoad;

  const pNew = store.actions.loadMore();
  await flush(1);
  const moreCalls = api.pending('log', isMoreLog);
  assert.equal(moreCalls.length, 2, 'new repo gets its own loadMore invoke');
  assert.deepEqual(moreCalls[1].args[0], { limit: 200, tips: ['n'], skip: 1 });

  oldMore.resolve({ commits: [commit('old-page')], hasMore: false, next: null });
  await pOld;
  assert.deepEqual(hashes(store), ['n1'], 'old repo page dropped');
  moreCalls[1].resolve({ commits: [commit('n0')], hasMore: false, next: null });
  await pNew;
  assert.deepEqual(hashes(store), ['n1', 'n0']);
  assert.equal(store.state.hasMore, false);
});

test('loadMore is a no-op without more history', async () => {
  const { api, store } = await loadedStore(repoData({ commits: chain(['a']) }));
  await store.actions.loadMore();
  assert.equal(api.pending('log', isMoreLog).length, 0);
});

test('loadMore called after a refresh, while the stale page is still in flight, loads the new cursor',
  async () => {
    const { api, store } = await loadedStore(pagedData(chain(['b', 'a']), { tips: ['old'], skip: 2 }));
    store.actions.loadMore();
    await flush(1);
    store.actions.refresh();
    await flush(1);
    await answerRefresh(api, pagedData(chain(['c', 'b', 'a']), { tips: ['new'], skip: 3 }));
    store.actions.loadMore();
    await flush(1);
    assert.equal(api.pending('log', (c) => isMoreLog(c) && c.args[0].tips[0] === 'new').length, 1);
  });

// ------------------------------------------------------------------ 3. commitFiles

test('commitFiles: a stale rejection for an earlier selection does not overwrite the latest', async () => {
  const { api, store } = await loadedStore(repoData({ commits: chain(['c', 'b', 'a']) }));
  api.take('commitFiles').resolve([]); // HEAD's default load
  await flush();

  store.actions.select({ kind: 'commit', sha: 'b' });
  assert.deepEqual(store.state.commitFiles, { sha: 'b', files: null, loading: true, error: null });
  store.actions.select({ kind: 'commit', sha: 'a' });
  const [callB, callA] = api.pending('commitFiles');
  assert.deepEqual(callB.args, ['b']);
  assert.deepEqual(callA.args, ['a']);

  const filesA = [{ path: 'x', status: 'M' }];
  callA.resolve(filesA);
  await flush();
  callB.reject({ message: 'boom', kind: 'git' });
  await flush();
  assert.deepEqual(store.state.commitFiles, { sha: 'a', files: filesA, loading: false, error: null });
});

test('commitFiles: an error for the current selection is shown', async () => {
  const { api, store } = await loadedStore(repoData({ commits: chain(['b', 'a']) }));
  api.take('commitFiles').reject({ message: 'bad object', kind: 'git' });
  await flush();
  assert.deepEqual(store.state.commitFiles, { sha: 'b', files: null, loading: false, error: 'bad object' });
});

test('select: same selection is a no-op; a new one closes an open diff', async () => {
  const { api, store } = await loadedStore(repoData({ commits: chain(['b', 'a']) }));
  const n = api.count('commitFiles');
  store.actions.select({ kind: 'commit', sha: 'b' });
  assert.equal(api.count('commitFiles'), n, 'reselecting HEAD does not reload');
  store.actions.openDiff({ kind: 'commit', sha: 'b', file: 'x' });
  assert.ok(store.state.diff);
  store.actions.select({ kind: 'commit', sha: 'a' });
  assert.equal(store.state.diff, null);
});

// ------------------------------------------------------------------ 4. stash selection

test('a selected stash (not in the log) survives refresh', async () => {
  const stashes = [{ hash: 'st1', parents: ['b'], message: 'WIP on main' }];
  const data = repoData({ commits: chain(['b', 'a']), stashes });
  const { api, store } = await loadedStore(data);
  const sel = { kind: 'commit', sha: 'st1' };
  store.actions.select(sel);
  const n = api.count('commitFiles');
  store.actions.refresh();
  await flush(1);
  await answerRefresh(api, data);
  assert.equal(store.state.selection, sel);
  assert.equal(api.count('commitFiles'), n, 'no reload of commit files');

  // once the stash is dropped, selection falls back to HEAD
  store.actions.refresh();
  await flush(1);
  await answerRefresh(api, repoData({ commits: chain(['b', 'a']) }));
  assert.deepEqual(store.state.selection, { kind: 'commit', sha: 'b' });
});

// ------------------------------------------------------------------ 5. working-copy diff

const wdSpec = { kind: 'workdir', file: 'a.txt', staged: false, untracked: false };

test('refresh with a clean tree closes the working-copy diff and selects HEAD', async () => {
  const dirty = repoData({ commits: chain(['b', 'a']), status: status({ oid: 'b', dirty: true }) });
  const { api, store } = await loadedStore(dirty);
  assert.deepEqual(store.state.selection, { kind: 'wip' });
  store.actions.openDiff(wdSpec);
  const d = api.take('workdirDiffView');
  assert.deepEqual(d.args, ['a.txt', { staged: false, untracked: false }]);
  d.resolve({ file: { path: 'a.txt', hunks: [] }, fingerprint: 'f', truncated: false });
  await flush();
  assert.equal(store.state.diff.loading, false);

  store.actions.refresh();
  await flush(1);
  await answerRefresh(api, repoData({ commits: chain(['b', 'a']) }));
  assert.equal(store.state.diff, null);
  assert.deepEqual(store.state.selection, { kind: 'commit', sha: 'b' });
  assert.equal(api.pending('workdirDiffView').length, 0, 'no reload for a closed diff');
  assert.deepEqual(api.take('commitFiles').args, ['b']);
});

test('reloadDiff returning {file:null} closes a workdir diff but not a commit diff', async () => {
  const dirty = repoData({ commits: chain(['b', 'a']), status: status({ oid: 'b', dirty: true }) });
  const { api, store } = await loadedStore(dirty);
  store.actions.openDiff(wdSpec);
  api.take('workdirDiffView').resolve({ file: { path: 'a.txt' }, fingerprint: 'f', truncated: false });
  await flush();

  // refresh (still dirty) keeps the diff and reloads it; the file is gone -> close
  store.actions.refresh();
  await flush(1);
  await answerRefresh(api, dirty);
  assert.ok(store.state.diff, 'still open while reloading');
  assert.equal(store.state.diff.data.file.path, 'a.txt', 'old data kept meanwhile');
  api.take('workdirDiffView').resolve({ file: null, fingerprint: 'g', truncated: false });
  await flush();
  assert.equal(store.state.diff, null);

  // commit diff with file:null stays open
  store.actions.select({ kind: 'commit', sha: 'a' });
  const cSpec = { kind: 'commit', sha: 'a', file: 'x', orig: undefined };
  store.actions.openDiff(cSpec);
  const c1 = api.take('commitDiffView');
  assert.deepEqual(c1.args, ['a', 'x', undefined]);
  c1.resolve({ file: { path: 'x' }, fingerprint: null, truncated: false });
  await flush();
  const p = store.actions.reloadDiff();
  api.take('commitDiffView').resolve({ file: null, fingerprint: null, truncated: false });
  await p;
  assert.ok(store.state.diff, 'commit diff not closed');
  assert.equal(store.state.diff.spec, cSpec);
  assert.equal(store.state.diff.data.file, null);
});

test('a commit diff stays open across a refresh that changes the selection defaults', async () => {
  const { api, store } = await loadedStore(repoData({ commits: chain(['b', 'a']) }));
  const cSpec = { kind: 'commit', sha: 'b', file: 'x' };
  store.actions.openDiff(cSpec);
  api.take('commitDiffView').resolve({ file: { path: 'x' } });
  await flush();
  store.actions.refresh();
  await flush(1);
  await answerRefresh(api, repoData({ commits: chain(['b', 'a']), status: status({ oid: 'b', dirty: true }) }));
  assert.ok(store.state.diff, 'commit diff kept');
  assert.equal(api.pending('commitDiffView').length, 1, 'and reloaded');
});

test('diff errors are shown for the current spec only', async () => {
  const { api, store } = await loadedStore(repoData({ commits: chain(['b', 'a']) }));
  const s1 = { kind: 'commit', sha: 'b', file: 'one' };
  const s2 = { kind: 'commit', sha: 'b', file: 'two' };
  store.actions.openDiff(s1);
  store.actions.openDiff(s2);
  const [d1, d2] = api.pending('commitDiffView');
  d2.reject({ message: 'too big' });
  await flush();
  d1.resolve({ file: { path: 'one' } });
  await flush();
  assert.deepEqual(store.state.diff, { spec: s2, loading: false, data: null, error: 'too big' });
  store.actions.closeDiff();
  assert.equal(store.state.diff, null);
});

// ------------------------------------------------------------------ 6. diff generations

test('two reloadDiff calls resolving out of order: the newest wins', async () => {
  const { api, store } = await loadedStore(repoData({ commits: chain(['b', 'a']) }));
  const spec = { kind: 'commit', sha: 'b', file: 'x' };
  store.actions.openDiff(spec);
  api.take('commitDiffView').resolve({ file: { path: 'x', v: 0 } });
  await flush();
  const p1 = store.actions.reloadDiff();
  const p2 = store.actions.reloadDiff();
  const [r1, r2] = api.pending('commitDiffView');
  r2.resolve({ file: { path: 'x', v: 2 } });
  await p2;
  r1.resolve({ file: { path: 'x', v: 1 } });
  await p1;
  assert.equal(store.state.diff.data.file.v, 2);
  assert.equal(store.state.diff.loading, false);
});

test('a reload bringing identical data (or the same error) sets nothing, so the diff view keeps its DOM', async () => {
  const { api, store } = await loadedStore(repoData({ commits: chain(['b', 'a']) }));
  const spec = { kind: 'commit', sha: 'b', file: 'x' };
  store.actions.openDiff(spec);
  api.take('commitDiffView').resolve({ file: { path: 'x', hunks: [{ header: '@@ -1 +1 @@' }] }, fingerprint: 'f' });
  await flush();
  const shown = store.state.diff;
  const seen = [];
  store.subscribe(['diff'], (s) => seen.push(s.diff));

  // same content, a new object from the IPC: nothing set
  const p1 = store.actions.reloadDiff();
  api.take('commitDiffView').resolve({ file: { path: 'x', hunks: [{ header: '@@ -1 +1 @@' }] }, fingerprint: 'f' });
  await p1;
  assert.equal(store.state.diff, shown, 'the same diff object');
  assert.deepEqual(seen, [], 'no diff notification');

  // changed content lands
  const p2 = store.actions.reloadDiff();
  api.take('commitDiffView').resolve({ file: { path: 'x', hunks: [] }, fingerprint: 'g' });
  await p2;
  assert.equal(seen.length, 1);
  assert.equal(store.state.diff.data.fingerprint, 'g');
  assert.equal(store.state.diff.spec, spec);

  // an error: shown once, the same error again sets nothing; a different one lands
  const fail = async (message) => {
    const p = store.actions.reloadDiff();
    api.take('commitDiffView').reject({ message });
    await p;
  };
  await fail('too big');
  assert.deepEqual(store.state.diff, { spec, loading: false, data: null, error: 'too big' });
  const failed = store.state.diff;
  await fail('too big');
  assert.equal(store.state.diff, failed, 'same error: unchanged');
  await fail('gone');
  assert.equal(store.state.diff.error, 'gone');
  assert.equal(seen.length, 3);

  // after an error, the same data as before the error lands again (the error state differs)
  const p3 = store.actions.reloadDiff();
  api.take('commitDiffView').resolve({ file: { path: 'x', hunks: [] }, fingerprint: 'g' });
  await p3;
  assert.equal(store.state.diff.error, null);
  assert.equal(seen.length, 4);
});

test('openDiff of the shown spec with identical data still lands (it showed loading meanwhile)', async () => {
  const { api, store } = await loadedStore(repoData({ commits: chain(['b', 'a']) }));
  const spec = { kind: 'commit', sha: 'b', file: 'x' };
  const data = { file: { path: 'x' }, fingerprint: 'f' };
  store.actions.openDiff(spec);
  api.take('commitDiffView').resolve(data);
  await flush();
  store.actions.openDiff(spec);
  assert.equal(store.state.diff.loading, true);
  api.take('commitDiffView').resolve({ ...data });
  await flush();
  assert.deepEqual(store.state.diff, { spec, loading: false, data, error: null });
});

test('watch: an identical working-copy diff reload after a status event notifies nobody', async () => {
  const dirty = repoData({ commits: chain(['b', 'a']), status: dirtyA() });
  const { api, store } = await loadedStore(dirty);
  store.actions.openDiff(wdSpec);
  api.take('workdirDiffView').resolve({ file: { path: 'a.txt', v: 1 }, fingerprint: 'f1' });
  await flush();
  const changes = [];
  store.subscribe(null, (s, changed) => changes.push(...changed));
  store.actions.watchEvent({ repo: '/r', kinds: ['status'], paths: ['a.txt'] });
  await flush(1);
  await answer(api, { status: dirtyA(), undoState: { entries: [] } });
  api.take('workdirDiffView').resolve({ file: { path: 'a.txt', v: 1 }, fingerprint: 'f1' });
  await flush();
  assert.deepEqual(changes, [], 'an idle watcher refresh sets nothing, the diff included');
});

test('reloadDiff with no diff open is a no-op', async () => {
  const { api, store } = await loadedStore(repoData({ commits: chain(['a']) }));
  await store.actions.reloadDiff();
  assert.equal(api.count('commitDiffView') + api.count('workdirDiffView'), 0);
});

// ------------------------------------------------------------------ 7. rows / pinning

test('dirty tree: WIP row first, parented to HEAD, HEAD chain pinned to column 0', async () => {
  // feature commit f is newer than HEAD's m2 and would otherwise take column 0
  const commits = [commit('f', ['m1']), commit('m2', ['m1']), commit('m1', ['m0']), commit('m0')];
  const { store } = await loadedStore(repoData({ commits, status: status({ oid: 'm2', dirty: true }) }));
  assert.deepEqual(rowKeys(store), ['WIP', 'f', 'm2', 'm1', 'm0']);
  const g = store.state.graph.rows;
  assert.equal(g[0].hash, 'WIP');
  assert.equal(g[0].column, 0);
  const col = Object.fromEntries(g.map((r) => [r.hash, r.column]));
  assert.equal(col.m2, 0);
  assert.equal(col.m1, 0);
  assert.equal(col.m0, 0);
  assert.notEqual(col.f, 0);
  // WIP's lane runs down to m2 in column 0
  assert.ok(g[0].lines.some((l) => l.to[0] === 0 && l.to[1] === 'bottom'));
});

test('clean tree: HEAD chain pinned to column 0 even when another branch is newer', async () => {
  const commits = [commit('f', ['m1']), commit('m2', ['m1']), commit('m1')];
  const { store } = await loadedStore(repoData({ commits, status: status({ oid: 'm2' }) }));
  assert.deepEqual(rowKeys(store), ['f', 'm2', 'm1']);
  const col = Object.fromEntries(store.state.graph.rows.map((r) => [r.hash, r.column]));
  assert.equal(col.m2, 0);
  assert.equal(col.m1, 0);
  assert.equal(col.f, 1);
  assert.deepEqual(store.state.selection, { kind: 'commit', sha: 'm2' }, 'HEAD selected, not the newest commit');
});

test('detached HEAD: pinned to its commit, HEAD ref indexed', async () => {
  const commits = [commit('f', ['m1']), commit('d', ['m1']), commit('m1')];
  const data = repoData({
    commits,
    status: status({ oid: 'd', branch: null }),
    refs: refs({ head: { oid: 'd', detached: true }, local: [{ name: 'main', oid: 'f', current: false, upstream: null }], tags: [{ name: 'v1', oid: 'd' }] }),
  });
  const { store } = await loadedStore(data);
  const col = Object.fromEntries(store.state.graph.rows.map((r) => [r.hash, r.column]));
  assert.equal(col.d, 0);
  assert.equal(col.m1, 0);
  assert.deepEqual(store.state.refsBySha.get('d'), [{ type: 'head', name: 'HEAD' }, { type: 'tag', name: 'v1' }]);
  assert.deepEqual(store.state.refsBySha.get('f'), [{ type: 'local', name: 'main', current: false, upstream: null }]);
  assert.deepEqual(store.state.selection, { kind: 'commit', sha: 'd' });
});

test('unborn repo with a dirty tree: WIP row without parents, WIP selected', async () => {
  const { store } = await loadedStore(repoData({ commits: [], status: status({ oid: null, staged: [{ path: 'new', status: 'A' }] }) }));
  assert.deepEqual(rowKeys(store), ['WIP']);
  assert.equal(store.state.graph.rows.length, 1);
  assert.equal(store.state.graph.rows[0].column, 0);
  assert.deepEqual(store.state.graph.rows[0].lines, [], 'no parent lane');
  assert.deepEqual(store.state.selection, { kind: 'wip' });
});

test('clean unborn repo: no rows, selection null', async () => {
  const { api, store } = await loadedStore(repoData({ commits: [], status: status({ oid: null }) }));
  assert.deepEqual(store.state.rows, []);
  assert.deepEqual(store.state.graph.rows, []);
  assert.equal(store.state.selection, null);
  assert.equal(api.count('commitFiles'), 0);
  assert.equal(store.state.loading, false);
});

test('conflicts alone make the tree dirty', async () => {
  const { store } = await loadedStore(repoData({ commits: chain(['a']), status: status({ oid: 'a', conflicted: [H.conflict('c')] }) }));
  assert.deepEqual(rowKeys(store), ['WIP', 'a']);
});

// ------------------------------------------------------------------ 8. selection defaults

test('selection defaults: dirty -> wip, clean -> HEAD, kept while it exists', async () => {
  const commits = chain(['c', 'b', 'a']);
  const { api, store } = await loadedStore(repoData({ commits, status: status({ oid: 'c', dirty: true }) }));
  assert.deepEqual(store.state.selection, { kind: 'wip' });
  assert.equal(api.count('commitFiles'), 0);

  const clean = repoData({ commits, status: status({ oid: 'b' }) }); // e.g. after reset
  store.actions.refresh();
  await flush(1);
  await answerRefresh(api, clean);
  assert.deepEqual(store.state.selection, { kind: 'commit', sha: 'b' }, 'HEAD (status.oid), not the first log row');

  const sel = { kind: 'commit', sha: 'a' };
  store.actions.select(sel);
  store.actions.refresh();
  await flush(1);
  await answerRefresh(api, clean);
  assert.equal(store.state.selection, sel, 'kept');

  // becoming dirty does not steal an existing commit selection
  store.actions.refresh();
  await flush(1);
  await answerRefresh(api, repoData({ commits, status: status({ oid: 'b', dirty: true }) }));
  assert.equal(store.state.selection, sel);

  // selected commit vanishes (rewritten history) -> default (dirty: wip)
  store.actions.refresh();
  await flush(1);
  await answerRefresh(api, repoData({ commits: chain(['x', 'b']), status: status({ oid: 'x', dirty: true }) }));
  assert.deepEqual(store.state.selection, { kind: 'wip' });
});

test('loadRepo resets state and toggles loading', async () => {
  const win = H.loadRenderer();
  const api = H.makeApi();
  const store = win.Store.create(api);
  const seen = [];
  store.subscribe(['loading'], (s) => seen.push(s.loading));
  const p = store.actions.loadRepo({ root: '/r', name: 'r' });
  assert.equal(store.state.loading, true);
  assert.equal(store.state.selection, null);
  await flush(1);
  assert.deepEqual(api.take('log').args, [{ limit: win.Store.PAGE_FIRST }]);
  await answerRefresh(api, repoData({ commits: chain(['a']) }));
  await p;
  assert.deepEqual(seen, [true, false]);
});

test('refresh without a repo does nothing', async () => {
  const win = H.loadRenderer();
  const api = H.makeApi();
  const store = win.Store.create(api);
  await store.actions.refresh();
  assert.equal(api.calls.length, 0);
});

// ------------------------------------------------------------------ 9. subscribe

test('subscribe filters by keys; throwing listeners do not stop others', async (t) => {
  const win = H.loadRenderer();
  const store = win.Store.create(H.makeApi());
  const errors = [];
  t.mock.method(console, 'error', (e) => errors.push(e));

  const all = [];
  const onlyBusy = [];
  store.subscribe(null, (s, keys) => all.push(keys));
  store.subscribe(['busy'], () => { throw new Error('listener boom'); });
  store.subscribe(['busy', 'loading'], (s, keys) => onlyBusy.push([s.busy, keys]));
  const unsub = store.subscribe([], (s, keys) => all.push(['empty-keys-means-all', ...keys]));

  store.set({ undoError: 'x' });
  assert.deepEqual(onlyBusy, []);
  store.set({ busy: true, undoError: 'x' }); // undoError unchanged -> not reported
  assert.deepEqual(onlyBusy, [[true, ['busy']]]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, 'listener boom');
  store.set({ busy: true }); // no change -> no notifications
  assert.equal(onlyBusy.length, 1);
  assert.deepEqual(all, [['undoError'], ['empty-keys-means-all', 'undoError'], ['busy'], ['empty-keys-means-all', 'busy']]);

  unsub();
  store.set({ busy: false });
  assert.equal(all.filter((k) => k[0] === 'empty-keys-means-all').length, 2, 'unsubscribed');
});

test('store.invoke turns plain rejection objects into Errors (keeping fields)', async () => {
  const win = H.loadRenderer();
  const api = H.makeApi();
  const store = win.Store.create(api);
  const p = store.invoke('status');
  api.take('status').reject({ message: 'nope', kind: 'not-a-repo' });
  await assert.rejects(p, (e) => e instanceof Error && e.message === 'nope' && e.kind === 'not-a-repo');
});

test('action errors go to the toast', async () => {
  const { api, store } = await loadedStore(repoData({ commits: chain(['a']) }));
  const toasts = [];
  store.setToast((e) => toasts.push(e));
  const p = store.actions.refresh();
  await flush(1);
  api.take('status').reject({ message: 'git died' });
  for (const op of ['refs', 'stashes', 'undoState']) api.take(op).resolve(null);
  await p;
  assert.equal(api.pending('log').length, 0, 'no history read after a failed status');
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].message, 'git died');
});

// ------------------------------------------------------------------ 10. undoError

test('undoError is set when undoState fails and cleared by the next good refresh', async () => {
  const data = repoData({ commits: chain(['a']) });
  const { api, store } = await loadedStore(data);
  assert.equal(store.state.undoError, null);
  store.actions.refresh();
  await flush(1);
  await answerRefresh(api, data, { rejectUndo: { message: 'undo log corrupt' } });
  assert.equal(store.state.undoError, 'undo log corrupt');
  assert.equal(store.state.undo, null);
  assert.deepEqual(hashes(store), ['a'], 'rest of the refresh still applied');

  store.actions.refresh();
  await flush(1);
  await answerRefresh(api, data);
  assert.equal(store.state.undoError, null);
  assert.deepEqual(store.state.undo, { entries: [] });
});

// ------------------------------------------------------------------ 11. selectRelative

test('selectRelative clamps at both ends and loads more near the end', async () => {
  const hs = Array.from({ length: 100 }, (_, i) => `c${99 - i}`);
  const { api, store } = await loadedStore(pagedData(chain(hs), { tips: ['c0'], skip: 100 }));
  assert.deepEqual(store.state.selection, { kind: 'commit', sha: 'c99' });

  store.actions.selectRelative(-5);
  assert.deepEqual(store.state.selection, { kind: 'commit', sha: 'c99' }, 'clamped at the top');
  store.actions.selectRelative(1);
  assert.deepEqual(store.state.selection, { kind: 'commit', sha: 'c98' });
  await flush(1);
  assert.equal(api.pending('log', isMoreLog).length, 0, 'far from the end: no paging');

  store.actions.selectRelative(1000);
  assert.deepEqual(store.state.selection, { kind: 'commit', sha: 'c0' }, 'clamped at the bottom');
  await flush(1);
  assert.equal(api.pending('log', isMoreLog).length, 1, 'near the end: loadMore');
  store.actions.selectRelative(1);
  await flush(1);
  assert.equal(api.count('log') - 1, 1, 'still one loadMore (shared)');
  assert.deepEqual(store.state.selection, { kind: 'commit', sha: 'c0' });

  // row 49 of 100 is not "near the end" (threshold: last 50 rows)
  store.actions.select({ kind: 'commit', sha: hs[0] });
  api.take('log', isMoreLog).resolve({ commits: [], hasMore: false, next: null });
  await flush();
  store.actions.selectRelative(49);
  assert.deepEqual(store.state.selection, { kind: 'commit', sha: hs[49] });
  store.actions.selectRelative(1);
  assert.deepEqual(store.state.selection, { kind: 'commit', sha: hs[50] });
});

test('selectRelative with the WIP row and with no rows', async () => {
  const empty = H.loadRenderer().Store.create(H.makeApi());
  empty.actions.selectRelative(1);
  assert.equal(empty.state.selection, null);

  const { store } = await loadedStore(repoData({ commits: chain(['b', 'a']), status: status({ oid: 'b', dirty: true }) }));
  assert.deepEqual(store.state.selection, { kind: 'wip' });
  store.actions.selectRelative(1);
  assert.deepEqual(store.state.selection, { kind: 'commit', sha: 'b' });
  store.actions.selectRelative(-1);
  assert.deepEqual(store.state.selection, { kind: 'wip' });
});

test('a refresh re-run requested while the running refresh fails still happens', async () => {
  const { api, store } = await loadedStore(repoData({ commits: chain(['a']) }));
  const first = store.actions.refresh();
  await flush(1);
  store.actions.refresh(); // coalesces into a re-run
  await flush(1);
  api.take('status').reject(new Error('boom'));
  for (const op of ['refs', 'stashes', 'undoState']) api.take(op).resolve(op === 'stashes' ? [] : null);
  await flush(3);
  assert.ok(api.pending('status').length >= 1, 'the requested re-run issued a new status call');
  await answerRefresh(api, repoData({ commits: chain(["a"]) }));
  await first; // the successful re-run clears the earlier error
  assert.ok(store.state.status);
});

test('a conflict diff (file null, conflict set) stays open across reloadDiff', async () => {
  const { api, store } = await loadedStore(repoData({ commits: chain(['a']), status: status({ conflicted: [H.conflict('f.txt')] }) }));
  const spec = { kind: 'workdir', file: 'f.txt', staged: false, untracked: false };
  const conflictData = { file: null, sections: [], fingerprint: null, truncated: false, maxLines: 20000, maxLineChars: 10000, conflict: { path: 'f.txt', hunks: [] } };
  const opened = store.actions.openDiff(spec);
  await flush(1);
  api.take('workdirDiffView').resolve(conflictData);
  await opened;
  const reloaded = store.actions.reloadDiff();
  await flush(1);
  api.take('workdirDiffView').resolve(conflictData);
  await reloaded;
  assert.ok(store.state.diff, 'conflict diff must not be closed');
  assert.equal(store.state.diff.data.conflict.path, 'f.txt');
});

test('a working-copy diff follows its file: untracked -> tracked after a partial stage; closes when the file leaves', async () => {
  const dirty = (unstaged, staged = []) => repoData({ commits: chain(['a']), status: status({ oid: 'a', unstaged, staged }) });
  const { api, store } = await loadedStore(dirty([{ path: 'n.md', status: '?' }]));
  const spec = { kind: 'workdir', file: 'n.md', staged: false, untracked: true };
  const opened = store.actions.openDiff(spec);
  await flush(1);
  api.take('workdirDiffView').resolve({ file: { hunks: [] }, sections: [], fingerprint: 'x', truncated: false, conflict: null });
  await opened;
  // part of it staged: now tracked (A in index, M in worktree)
  const r1 = store.actions.refresh();
  await flush(1);
  await answerRefresh(api, dirty([{ path: 'n.md', status: 'M' }], [{ path: 'n.md', status: 'A' }]));
  await flush(2);
  assert.equal(store.state.diff.spec.untracked, false, 'spec switched to the tracked unstaged diff');
  const call = api.take('workdirDiffView');
  assert.deepEqual(call.args[1], { staged: false, untracked: false });
  call.resolve({ file: { hunks: [] }, sections: [], fingerprint: 'y', truncated: false, conflict: null });
  await r1;
  // fully staged: gone from the unstaged list -> closed
  const r2 = store.actions.refresh();
  await flush(1);
  await answerRefresh(api, dirty([], [{ path: 'n.md', status: 'A' }]));
  await r2;
  assert.equal(store.state.diff, null);
});

test('staged rename diffs pass orig to workdirDiffView', async () => {
  const { api, store } = await loadedStore(repoData({ commits: chain(['a']), status: status({ oid: 'a', staged: [{ path: 'new.txt', status: 'R', orig: 'old.txt' }] }) }));
  store.actions.openDiff({ kind: 'workdir', file: 'new.txt', staged: true, untracked: false, orig: 'old.txt' });
  await flush(1);
  assert.deepEqual(api.take('workdirDiffView').args, ['new.txt', { staged: true, untracked: false, orig: 'old.txt' }]);
});

// ------------------------------------------------------------------ 12. history cap (LOG_MAX)

const longChain = (n, prefix = 'c') => chain(Array.from({ length: n }, (_, i) => `${prefix}${n - 1 - i}`));

test('history is capped at LOG_MAX: loadMore asks only for the room left and stops; refresh never asks for more', async () => {
  const { win } = await loadedStore(repoData({ commits: chain(['a']) }));
  const MAX = win.Store.LOG_MAX;
  assert.equal(MAX, 10000, 'mirrors ops.js LOG_MAX');
  const start = longChain(MAX - 100);
  const { api, store } = await loadedStore(pagedData(start, { tips: ['t'], skip: MAX - 100 }));
  const p = store.actions.loadMore();
  await flush(1);
  const more = api.take('log', isMoreLog);
  assert.equal(more.args[0].limit, 100, 'only the room left under the cap');
  more.resolve({ commits: longChain(100, 'm'), hasMore: true, next: { tips: ['t'], skip: MAX } });
  await p;
  assert.equal(store.state.commits.length, MAX);
  assert.equal(store.state.hasMore, false, 'no more paging at the cap');
  assert.equal(store.state.next, null);
  await store.actions.loadMore();
  assert.equal(api.pending('log', isMoreLog).length, 0);

  // a refresh with a moved tip re-reads at most LOG_MAX commits (ops.js rejects more)
  store.actions.refresh();
  await flush(1);
  const moved = pagedData(longChain(MAX + 0, 'n'), { tips: ['n'], skip: MAX });
  moved.status = status({ oid: 'n9999' });
  api.take('status').resolve(moved.status);
  api.take('refs').resolve(moved.refs);
  api.take('stashes').resolve([]);
  api.take('undoState').resolve(moved.undoState);
  await flush();
  const log = api.take('log', isRefreshLog);
  assert.deepEqual(log.args[0], { limit: MAX });
  log.resolve(moved.log);
  await flush();
  assert.equal(store.state.commits.length, MAX);
  assert.equal(store.state.hasMore, false, 'backend hasMore is clamped at the cap');
});

// ------------------------------------------------------------------ 13. refresh vs a landing loadMore page

test('a refresh whose log was requested before a loadMore page landed is dropped and re-run with the new length', async () => {
  const { win, api, store } = await loadedStore(pagedData(chain(['b', 'a']), { tips: ['t'], skip: 2 }));
  const sel = { kind: 'commit', sha: 'a' };
  store.actions.select(sel);
  const pMore = store.actions.loadMore();
  await flush(1);
  const more = api.take('log', isMoreLog);

  // refresh with a moved tip: its log goes out while the page is still in flight
  const pRef = store.actions.refresh();
  await flush(1);
  const moved = pagedData(chain(['c', 'b', 'a']), { tips: ['c'], skip: 3 });
  api.take('status').resolve(moved.status);
  api.take('refs').resolve(moved.refs);
  api.take('stashes').resolve([]);
  api.take('undoState').resolve(moved.undoState);
  await flush();
  const log1 = api.take('log', isRefreshLog);
  assert.deepEqual(log1.args[0], { limit: win.Store.PAGE_FIRST }, 'a short history re-reads at least a first page');

  // the page lands first
  more.resolve({ commits: [commit('x', ['y']), commit('y')], hasMore: true, next: { tips: ['t'], skip: 4 } });
  await pMore;
  assert.deepEqual(hashes(store), ['b', 'a', 'x', 'y']);

  // then the refresh's (older-length) log: dropped, not applied
  log1.resolve(moved.log);
  await flush();
  assert.deepEqual(hashes(store), ['b', 'a', 'x', 'y'], 'loaded page not wiped');
  assert.equal(store.state.selection, sel, 'selection kept');
  assert.ok(api.pending('status').length === 1, 're-run started');
  const reran = await answerRefresh(api, pagedData(chain(['c', 'b', 'a', 'x', 'y']), { tips: ['c'], skip: 5 }));
  assert.ok(reran, 're-run reads the log again');
  await pRef;
  assert.deepEqual(hashes(store), ['c', 'b', 'a', 'x', 'y']);
  assert.equal(store.state.selection, sel);
});

// ------------------------------------------------------------------ 14. idle refreshes

test('a refresh with unchanged tips does not read the log and notifies nobody', async () => {
  const data = repoData({
    commits: chain(['b', 'a']),
    refs: refs({ local: [{ name: 'main', oid: 'b', current: true, upstream: null }] }),
    stashes: [{ hash: 's1', parents: ['b'], message: 'm', ref: 'stash@{0}' }],
  });
  const { api, store } = await loadedStore(data);
  const before = { commits: store.state.commits, rows: store.state.rows, graph: store.state.graph, status: store.state.status };
  const changes = [];
  store.subscribe(null, (s, keys) => changes.push(...keys));
  const logs = api.count('log');

  store.actions.refresh();
  await flush(1);
  // fresh but identical objects from the backend
  const again = JSON.parse(JSON.stringify(data));
  const readLog = await answerRefresh(api, again);
  assert.equal(readLog, false, 'log not requested');
  assert.equal(api.count('log'), logs);
  assert.deepEqual(changes, [], 'no key changed');
  assert.equal(store.state.commits, before.commits);
  assert.equal(store.state.graph, before.graph);
  assert.equal(store.state.status, before.status, 'identical status object kept');

  // only the working tree changed: status + rows (WIP row), still no log
  store.actions.refresh();
  await flush(1);
  const dirty = JSON.parse(JSON.stringify(data));
  dirty.status = status({ oid: 'b', dirty: true });
  assert.equal(await answerRefresh(api, dirty), false);
  assert.deepEqual(changes.sort(), ['graph', 'rows', 'status'], 'the HEAD selection is kept');
  assert.deepEqual(rowKeys(store), ['WIP', 'b', 'a']);
  assert.equal(store.state.commits, before.commits);

  // a branch moved: log re-read
  changes.length = 0;
  store.actions.refresh();
  await flush(1);
  const moved = JSON.parse(JSON.stringify(dirty));
  moved.refs.local.push({ name: 'feat', oid: 'f', current: false, upstream: null });
  moved.log.commits.unshift(commit('f', ['b']));
  assert.equal(await answerRefresh(api, moved), true);
  assert.deepEqual(hashes(store), ['f', 'b', 'a']);
  assert.ok(!changes.includes('status'), 'unchanged status not re-set');
});

// ------------------------------------------------------------------ 15. load errors / degraded stashes

test('a failed first load sets loadError (not an empty repo); the next good refresh clears it', async () => {
  const win = H.loadRenderer();
  const api = H.makeApi();
  const store = win.Store.create(api);
  const p = store.actions.loadRepo({ root: '/r', name: 'r' });
  await flush(1);
  api.take('status').reject({ message: 'fatal: bad object HEAD' });
  for (const op of ['refs', 'stashes', 'undoState']) api.take(op).resolve(null);
  api.take('log').resolve({ commits: [], hasMore: false, next: null });
  await assert.rejects(p, /bad object/);
  assert.equal(store.state.loadError, 'fatal: bad object HEAD');
  assert.equal(store.state.loading, false);

  store.actions.refresh();
  await flush(1);
  await answerRefresh(api, repoData({ commits: chain(['a']) }));
  assert.equal(store.state.loadError, null);
  assert.deepEqual(hashes(store), ['a']);
});

test('a failed refresh after a good load does not set loadError', async () => {
  const { api, store } = await loadedStore(repoData({ commits: chain(['a']) }));
  store.setToast(() => {});
  const p = store.actions.refresh();
  await flush(1);
  api.take('status').reject({ message: 'transient' });
  for (const op of ['refs', 'stashes', 'undoState']) api.take(op).resolve(null);
  await p;
  assert.equal(store.state.loadError, null);
});

test('stashes failing degrades like undoState: the rest applies, the last list is kept, stashError set', async () => {
  const stashes = [{ hash: 's1', parents: ['b'], message: 'm', ref: 'stash@{0}' }];
  const data = repoData({ commits: chain(['b', 'a']), stashes });
  const { api, store } = await loadedStore(data);
  const kept = store.state.stashes;
  store.actions.refresh();
  await flush(1);
  const moved = repoData({ commits: chain(['c', 'b', 'a']), stashes });
  await answerRefresh(api, moved, { rejectStashes: { message: 'stash reflog corrupt' } });
  assert.deepEqual(hashes(store), ['c', 'b', 'a'], 'refresh still applied');
  assert.equal(store.state.stashes, kept);
  assert.equal(store.state.stashError, 'stash reflog corrupt');

  store.actions.refresh();
  await flush(1);
  await answerRefresh(api, moved);
  assert.equal(store.state.stashError, null);
});

test('a failed first load with only stashes failing still loads the repo', async () => {
  const win = H.loadRenderer();
  const api = H.makeApi();
  const store = win.Store.create(api);
  const p = store.actions.loadRepo({ root: '/r', name: 'r' });
  await flush(1);
  await answerRefresh(api, repoData({ commits: chain(['a']) }), { rejectStashes: { message: 'nope' } });
  await p;
  assert.deepEqual(hashes(store), ['a']);
  assert.deepEqual(store.state.stashes, []);
  assert.equal(store.state.stashError, 'nope');
  assert.equal(store.state.loadError, null);
});

// ------------------------------------------------------------------ 16. selection helpers

test('selectRelative does nothing while a stash (no graph row) is selected', async () => {
  const stashes = [{ hash: 'st1', parents: ['b'], message: 'm' }];
  const { store } = await loadedStore(repoData({ commits: chain(['c', 'b', 'a']), stashes }));
  const sel = { kind: 'commit', sha: 'st1' };
  store.actions.select(sel);
  store.actions.selectRelative(1);
  assert.equal(store.state.selection, sel);
  store.actions.selectRelative(-1);
  assert.equal(store.state.selection, sel);
});

test('rowIndexOf and isDirty', async () => {
  const { store } = await loadedStore(repoData({ commits: chain(['b', 'a']), status: status({ oid: 'b', dirty: true }) }));
  assert.equal(store.rowIndexOf({ kind: 'wip' }), 0);
  assert.equal(store.rowIndexOf({ kind: 'commit', sha: 'a' }), 2);
  assert.equal(store.rowIndexOf({ kind: 'commit', sha: 'zz' }), -1);
  assert.equal(store.rowIndexOf(null), -1);
  assert.equal(store.rowIndexOf(), 0, 'defaults to the current selection (WIP)');
  assert.equal(store.isDirty(), true);
  assert.equal(store.isDirty(status({ oid: 'b' })), false);
  assert.equal(store.isDirty(null), false);
});

// ------------------------------------------------------------------ 17. paging layout

test('loadMore resumes the saved layout: rows/graph equal a full layout of the whole history', async () => {
  const commits = [commit('f', ['m1']), commit('m2', ['m1']), commit('m1', ['m0', 'x1'])];
  const page = [commit('x1', ['m0']), commit('m0', ['r'])];
  const { win, api, store } = await loadedStore(pagedData(commits, { tips: ['t'], skip: 3 }));
  const { status: st } = store.state;
  const p = store.actions.loadMore();
  await flush(1);
  api.take('log', isMoreLog).resolve({ commits: page, hasMore: false, next: null });
  await p;
  const full = win.Graph.layout(commits.concat(page).map((c) => ({ hash: c.hash, parents: c.parents })), { pinned: st.oid });
  assert.deepEqual(store.state.graph, full);
  assert.deepEqual(hashes(store), ['f', 'm2', 'm1', 'x1', 'm0']);
});

// ------------------------------------------------------------------ 18. write / loadMore back-off

test('write: returns the value; errors are toasted (toasted = true) and re-thrown; quiet kinds are not toasted', async () => {
  const { api, store } = await loadedStore(repoData({ commits: chain(['a']) }));
  const toasts = [];
  store.setToast((e) => toasts.push(e));

  const ok = store.actions.write('stage', [['a.txt']]);
  const c1 = api.take('stage');
  assert.deepEqual(c1.args, [['a.txt']]);
  c1.resolve({ done: true });
  assert.deepEqual(await ok, { done: true });

  const bad = store.actions.write('commit', ['msg']);
  api.take('commit').reject({ message: 'hook failed', kind: 'hook-failed' });
  await assert.rejects(bad, (e) => e instanceof Error && e.kind === 'hook-failed' && e.toasted === true);
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].message, 'hook failed');

  const quiet = store.actions.write('stageHunk', [], { quiet: ['stale'] });
  api.take('stageHunk').reject({ message: 'changed', kind: 'stale' });
  await assert.rejects(quiet, (e) => e.kind === 'stale' && !e.toasted);
  assert.equal(toasts.length, 1, 'quiet kind not toasted');

  const loud = store.actions.write('stageHunk', [], { quiet: ['stale'] });
  api.take('stageHunk').reject({ message: 'conflict', kind: 'conflict' });
  await assert.rejects(loud, (e) => e.toasted === true);
  assert.equal(toasts.length, 2);
});

test('loadMore backs off for 5 s after a failure, then retries', async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { api, store } = await loadedStore(pagedData(chain(['b', 'a']), { tips: ['t'], skip: 2 }));
  const toasts = [];
  store.setToast((e) => toasts.push(e));
  const p = store.actions.loadMore();
  await flush(1);
  api.take('log', isMoreLog).reject({ message: 'timeout', kind: 'timeout' });
  await p;
  assert.equal(toasts.length, 1, 'toasted once via the action');

  now += 4999;
  await store.actions.loadMore();
  assert.equal(api.pending('log', isMoreLog).length, 0, 'within the back-off: no new invoke');
  now += 1;
  store.actions.loadMore();
  await flush(1);
  assert.equal(api.pending('log', isMoreLog).length, 1, 'after 5 s: retried');
});

test('loadRemotes: a failure is logged and kept in remotesError; an older read never lands after a newer one', async (t) => {
  const logged = [];
  const saved = console.error;
  console.error = (...a) => logged.push(a);
  t.after(() => { console.error = saved; });
  const { api, store } = await loadedStore(repoData({ commits: chain(['a']) }));
  api.take('remotes').resolve(['origin']);
  await flush();
  assert.deepEqual(store.state.remotes, ['origin']);
  assert.equal(store.state.remotesError, null);

  const failing = store.actions.loadRemotes();
  api.take('remotes').reject({ message: 'fatal: bad config', kind: 'git' });
  assert.deepEqual(await failing, ['origin'], 'the last list on failure');
  assert.equal(store.state.remotesError, 'fatal: bad config');
  assert.equal(logged.length, 1);

  // Two reads in flight: the older one fails last, but the newer success wins.
  const older = store.actions.loadRemotes();
  const newer = store.actions.loadRemotes();
  const [o, n] = api.pending('remotes');
  n.resolve(['origin', 'fork']);
  await newer;
  o.reject({ message: 'late failure' });
  await older;
  assert.deepEqual(store.state.remotes, ['origin', 'fork']);
  assert.equal(store.state.remotesError, null, 'the stale failure is ignored');

  // A repo switch resets it.
  store.set({ remotesError: 'x' });
  const p = store.actions.loadRepo({ root: '/other', name: 'other' });
  assert.equal(store.state.remotesError, null);
  await flush(1);
  await H.answerRefresh(api, repoData({ commits: chain(['b']) }));
  await p;
});

// ------------------------------------------------------------------ worktrees

const WT = (path, o = {}) => ({ path, head: 'a'.repeat(40), branch: null, bare: false, detached: false, locked: false, lockReason: null, prunable: false, prunableReason: null, main: false, current: false, ...o });
const MAIN_WT = WT('/r', { branch: 'main', main: true, current: true });

/** A loaded normal repo whose first worktrees read was answered with `list`. */
async function withWorktrees(list, data = repoData({ commits: chain(['a']) })) {
  const s = await loadedStore(data);
  s.api.take('worktrees').resolve(list);
  await flush();
  return s;
}

/** Run a full refresh (answered with `data`), leaving its worktrees read pending. */
async function fullRefresh(api, store, data = repoData({ commits: chain(['a']) })) {
  const p = store.actions.refresh();
  await flush(1);
  await answerRefresh(api, data);
  await p;
}

test('worktrees: a normal repository reads them on the first load and with each full refresh, not with a partial one; a failure keeps the list', async (t) => {
  const logged = [];
  const saved = console.error;
  console.error = (...a) => logged.push(a);
  t.after(() => { console.error = saved; });
  const list = [MAIN_WT, WT('/w/feat', { branch: 'feat' })];
  const { api, store } = await withWorktrees(list);
  assert.equal(api.count('worktrees'), 1, 'read with the first load');
  assert.deepEqual(store.state.worktrees, list);

  await fullRefresh(api, store);
  api.take('worktrees').reject({ message: 'boom' });
  await flush();
  assert.deepEqual(store.state.worktrees, list, 'the last list on failure');
  assert.match(String(logged[0][0]), /could not read the worktrees/);

  store.actions.watchEvent({ repo: '/r', kinds: ['status'] });
  await flush(1);
  api.take('status').resolve(status({ oid: 'a' }));
  api.take('undoState').resolve({ entries: [] });
  await flush();
  assert.equal(api.count('worktrees'), 2, 'a partial refresh does not read them');

  store.actions.watchEvent({ repo: '/r', kinds: ['refs'] });
  await flush(1);
  await answerRefresh(api, repoData({ commits: chain(['a']) }));
  const added = [...list, WT('/w/new')];
  api.take('worktrees').resolve(added);
  await flush();
  assert.deepEqual(store.state.worktrees, added, 'a refs event (full) re-reads them');
});

test('worktrees: loadRepo clears worktrees and worktreeDirty, and a stale read from the old repo is dropped', async () => {
  const { api, store } = await withWorktrees([MAIN_WT, WT('/w/a')]);
  store.actions.setWorktreeDirtyWanted(true);
  api.take('worktreeDirty').resolve([{ path: '/w/a', dirty: true }]);
  await flush();
  assert.deepEqual(store.state.worktreeDirty, { '/w/a': true });

  await fullRefresh(api, store); // its worktrees read stays pending across the switch
  const p = store.actions.loadRepo({ root: '/s', name: 's' });
  assert.deepEqual([store.state.worktrees, store.state.worktreeDirty], [null, null]);
  await flush(1);
  await answerRefresh(api, repoData({ commits: chain(['z']) }));
  await p;
  const [stale, fresh] = api.pending('worktrees');
  stale.resolve([MAIN_WT, WT('/w/a'), WT('/w/old')]);
  await flush();
  assert.equal(store.state.worktrees, null, 'the old repo\'s list never lands');
  fresh.resolve([WT('/s', { main: true, current: true }), WT('/w/a')]);
  await flush();
  assert.equal(store.state.worktrees.length, 2);
  assert.equal(api.pending('worktreeDirty').length, 1, 'still wanted: the new repo\'s worktrees are checked, the same path included (TTL reset)');
});

test('worktreeDirty: read only while wanted; a 5 s TTL for the same paths; a changed path list or the TTL re-read', async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const list = [WT('/bare', { bare: true, main: true }), MAIN_WT, WT('/w/b'), WT('/w/a', { locked: true }), WT('/w/gone', { prunable: true })];
  const { api, store } = await withWorktrees(list);
  assert.equal(api.count('worktreeDirty'), 0, 'not wanted: never read');
  await fullRefresh(api, store);
  api.take('worktrees').resolve(list);
  await flush();
  assert.equal(api.count('worktreeDirty'), 0, 'not wanted: a full refresh does not read it either');
  assert.equal(store.state.worktreeDirty, null);

  store.actions.setWorktreeDirtyWanted(true);
  assert.equal(api.count('worktreeDirty'), 1, 'wanted: read at once');
  assert.deepEqual(api.take('worktreeDirty').args, [], 'no arguments: main lists the worktrees itself');
  api.take('worktreeDirty').resolve([{ path: '/w/a', dirty: false }, { path: '/w/b', dirty: true }, { path: '/w/x', dirty: null }]);
  await flush();
  assert.deepEqual(store.state.worktreeDirty, { '/w/a': false, '/w/b': true, '/w/x': null });

  // within the TTL, the same paths: no second read (setWorktreeDirtyWanted, a full refresh, loadWorktreeDirty)
  now += 4999;
  store.actions.setWorktreeDirtyWanted(true);
  await fullRefresh(api, store);
  api.take('worktrees').resolve(list);
  await flush();
  await store.actions.loadWorktreeDirty();
  assert.equal(api.count('worktreeDirty'), 1, 'within 5 s: no second read');

  // after the TTL, loadWorktreeDirty re-reads
  now += 1;
  const forced = store.actions.loadWorktreeDirty();
  api.take('worktreeDirty').resolve([{ path: '/w/a', dirty: true }, { path: '/w/b', dirty: true }]);
  await forced;
  assert.deepEqual(store.state.worktreeDirty, { '/w/a': true, '/w/b': true });

  // a changed path list re-reads within the TTL
  await fullRefresh(api, store);
  api.take('worktrees').resolve([...list, WT('/w/c')]);
  await flush();
  assert.equal(api.count('worktreeDirty'), 3, 'a new worktree: re-read');
  api.take('worktreeDirty').resolve([{ path: '/w/a', dirty: true }, { path: '/w/b', dirty: true }, { path: '/w/c', dirty: false }]);
  await flush();

  // the TTL expired: the next full refresh re-reads
  now += 5000;
  await fullRefresh(api, store);
  api.take('worktrees').resolve([...list, WT('/w/c')]);
  await flush();
  assert.equal(api.count('worktreeDirty'), 4, 'after 5 s: re-read');

  // a failure keeps the last value and is retried by the next read
  const logged = [];
  const saved = console.error;
  console.error = (...a) => logged.push(a);
  t.after(() => { console.error = saved; });
  api.take('worktreeDirty').reject({ message: 'boom' });
  await flush();
  assert.deepEqual(store.state.worktreeDirty, { '/w/a': true, '/w/b': true, '/w/c': false }, 'the last value on failure');
  assert.match(String(logged[0][0]), /could not read the worktrees' state/);
  const retried = store.actions.loadWorktreeDirty();
  assert.equal(api.count('worktreeDirty'), 5, 'a failed read does not hold the TTL');
  api.take('worktreeDirty').resolve([]);
  await retried;

  // closed: full refreshes no longer read it
  store.actions.setWorktreeDirtyWanted(false);
  now += 10_000;
  await fullRefresh(api, store);
  api.take('worktrees').resolve(list);
  await flush();
  assert.equal(api.count('worktreeDirty'), 5, 'not wanted any more: not read');
});

test('worktreeDirty: a read still running when the TTL expires is shared, not overlapped; the TTL counts from its end', async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const list = [MAIN_WT, WT('/w/a')];
  const { api, store } = await withWorktrees(list);
  store.actions.setWorktreeDirtyWanted(true);
  assert.equal(api.count('worktreeDirty'), 1);
  const slow = api.take('worktreeDirty');

  // the read is still running 6 s later: refreshes and explicit loads share it
  now += 6000;
  await fullRefresh(api, store);
  api.take('worktrees').resolve(list);
  await flush();
  const shared = store.actions.loadWorktreeDirty();
  store.actions.setWorktreeDirtyWanted(true);
  assert.equal(api.count('worktreeDirty'), 1, 'no second read while the first is in flight');
  slow.resolve([{ path: '/w/a', dirty: true }]);
  await shared;
  assert.deepEqual(store.state.worktreeDirty, { '/w/a': true }, 'the shared promise settles with the read');

  // the TTL counts from the end of the read: 4.9 s later, still fresh
  now += 4900;
  await store.actions.loadWorktreeDirty();
  assert.equal(api.count('worktreeDirty'), 1, 'within 5 s of the read finishing');
  now += 100;
  store.actions.loadWorktreeDirty();
  assert.equal(api.count('worktreeDirty'), 2, '5 s after it finished: re-read');
  api.take('worktreeDirty').resolve([{ path: '/w/a', dirty: false }]);
  await flush();
});

test('worktreeDirty: missing entries (their folder is gone) are not checked', async () => {
  const { api, store } = await withWorktrees([MAIN_WT, WT('/w/a'), WT('/w/away', { locked: true, missing: true })]);
  store.actions.setWorktreeDirtyWanted(true);
  assert.equal(api.count('worktreeDirty'), 1);
  api.take('worktreeDirty').resolve([{ path: '/w/a', dirty: false }, { path: '/w/away', dirty: null }]);
  await flush();
  // the list loses the missing entry: the same checkable paths, so no re-read within the TTL
  await fullRefresh(api, store);
  api.take('worktrees').resolve([MAIN_WT, WT('/w/a')]);
  await flush();
  assert.equal(api.count('worktreeDirty'), 1, 'the checkable-paths key excludes missing entries');

  const only = await withWorktrees([MAIN_WT, WT('/w/away', { missing: true })]);
  only.store.actions.setWorktreeDirtyWanted(true);
  await flush();
  assert.deepEqual(only.store.state.worktreeDirty, {});
  assert.equal(only.api.count('worktreeDirty'), 0, 'only missing ones: nothing to read');
});

test('worktreeDirty: with only the current (and bare or prunable) entries there is nothing to check: {} with no read', async () => {
  const { api, store } = await withWorktrees([MAIN_WT, WT('/w/gone', { prunable: true })]);
  store.actions.setWorktreeDirtyWanted(true);
  await flush();
  assert.deepEqual(store.state.worktreeDirty, {});
  assert.equal(api.count('worktreeDirty'), 0);
});

test('worktreeDirty: wanted before the worktrees are read: read once they are', async () => {
  const win = H.loadRenderer();
  const api = H.makeApi();
  const store = win.Store.create(api);
  const p = store.actions.loadRepo({ root: '/r', name: 'r' });
  store.actions.setWorktreeDirtyWanted(true);
  await flush(1);
  await answerRefresh(api, repoData({ commits: chain(['a']) }));
  await p;
  assert.equal(api.count('worktreeDirty'), 0, 'no list yet: nothing to check');
  api.take('worktrees').resolve([MAIN_WT, WT('/w/a')]);
  await flush();
  assert.equal(api.count('worktreeDirty'), 1);
});

test('worktreeDirty: an older read never lands after a newer one, and a stale result after a repo switch is dropped', async () => {
  const { api, store } = await withWorktrees([MAIN_WT, WT('/w/a')]);
  store.actions.setWorktreeDirtyWanted(true);
  await fullRefresh(api, store);
  api.take('worktrees').resolve([MAIN_WT, WT('/w/a'), WT('/w/b')]); // another path list: a second read while the first runs
  await flush();
  const [older, newer] = api.pending('worktreeDirty');
  assert.ok(older && newer);
  newer.resolve([{ path: '/w/a', dirty: true }, { path: '/w/b', dirty: true }]);
  await flush();
  older.resolve([{ path: '/w/a', dirty: false }]);
  await flush();
  assert.deepEqual(store.state.worktreeDirty, { '/w/a': true, '/w/b': true }, 'the newer read wins');

  await fullRefresh(api, store);
  api.take('worktrees').resolve([MAIN_WT, WT('/w/a')]);
  await flush();
  const late = api.take('worktreeDirty');
  const p = store.actions.loadRepo({ root: '/s', name: 's' });
  late.resolve([{ path: '/w/a', dirty: false }]);
  await flush(1);
  assert.equal(store.state.worktreeDirty, null, 'the old repo\'s result is dropped');
  await answerRefresh(api, repoData({ commits: chain(['z']) }));
  await p;
});

// ------------------------------------------------------------------ watcher events

const REFRESH_OPS = ['status', 'refs', 'stashes', 'undoState', 'log', 'workdirDiffView', 'commitDiffView'];
/** Unsettled calls by op, e.g. {status: 1, undoState: 1}. */
const pendingOps = (api) => {
  const out = {};
  for (const op of REFRESH_OPS) {
    const n = api.pending(op).length;
    if (n) out[op] = n;
  }
  return out;
};
/** Resolve the first pending call of each op given ({op: value}), then let it land. */
async function answer(api, values) {
  for (const [op, v] of Object.entries(values)) api.take(op).resolve(v);
  await flush();
}
const dirtyA = (oid = 'b') => status({ oid, unstaged: [{ path: 'a.txt', status: 'M' }] });

test('watch: events for another repo root, or malformed ones, are ignored', async () => {
  const { api, store } = await loadedStore(repoData({ commits: chain(['b', 'a']) }));
  const before = api.calls.length;
  store.actions.watchEvent({ repo: '/other', kinds: ['full'] });
  store.actions.watchEvent({ repo: '/r' });
  store.actions.watchEvent(null);
  store.actions.watchEvent({ repo: '/r', kinds: ['nonsense'] });
  await flush();
  assert.equal(api.calls.length, before);
});

test('watch: full and refs run a full refresh', async () => {
  for (const kind of ['full', 'refs']) {
    const { api, store } = await loadedStore(repoData({ commits: chain(['b', 'a']) }));
    api.pending('remotes').forEach((c) => c.resolve(['origin']));
    store.actions.watchEvent({ repo: '/r', kinds: [kind] });
    await flush(1);
    assert.deepEqual(pendingOps(api), { status: 1, refs: 1, stashes: 1, undoState: 1 }, kind);
    await answerRefresh(api, repoData({ commits: chain(['c', 'b', 'a']) }));
    assert.deepEqual(hashes(store), ['c', 'b', 'a'], `${kind}: the moved tip is read`);
  }
});

test('watch: stashes reads only the stash list', async () => {
  const { api, store } = await loadedStore(repoData({ commits: chain(['b', 'a']) }));
  const statusBefore = store.state.status;
  store.actions.watchEvent({ repo: '/r', kinds: ['stashes'] });
  await flush(1);
  assert.deepEqual(pendingOps(api), { stashes: 1 });
  const list = [{ hash: 's1', index: 0, subject: 'WIP on main' }];
  await answer(api, { stashes: list });
  assert.deepEqual(store.state.stashes, list);
  assert.equal(store.state.status, statusBefore, 'status untouched');
  assert.deepEqual(pendingOps(api), {});
});

test('watch: a failing stash read keeps the list and sets stashError; undoError is left alone', async () => {
  const { api, store } = await loadedStore(repoData({ commits: chain(['b', 'a']), stashes: [{ hash: 's0', index: 0 }] }));
  store.set({ undoError: 'earlier' });
  store.actions.watchEvent({ repo: '/r', kinds: ['stashes'] });
  await flush(1);
  api.take('stashes').reject({ message: 'bad stash' });
  await flush();
  assert.deepEqual(store.state.stashes, [{ hash: 's0', index: 0 }]);
  assert.equal(store.state.stashError, 'bad stash');
  assert.equal(store.state.undoError, 'earlier', 'not read, so not cleared');
});

test('watch: status reads status + undo state and adds the WIP row', async () => {
  const { api, store } = await loadedStore(repoData({ commits: chain(['b', 'a']) }));
  assert.deepEqual(rowKeys(store), ['b', 'a']);
  store.actions.watchEvent({ repo: '/r', kinds: ['status'], paths: ['a.txt'] });
  await flush(1);
  assert.deepEqual(pendingOps(api), { status: 1, undoState: 1 });
  await answer(api, { status: dirtyA(), undoState: { entries: [] } });
  assert.deepEqual(rowKeys(store), ['WIP', 'b', 'a']);
  assert.deepEqual(store.state.selection, { kind: 'commit', sha: 'b' }, 'an existing selection is kept');
  assert.deepEqual(pendingOps(api), {}, 'no log, refs or stashes');
});

test('watch: status with a moved HEAD escalates to a full refresh', async () => {
  const { api, store } = await loadedStore(repoData({ commits: chain(['b', 'a']) }));
  store.actions.watchEvent({ repo: '/r', kinds: ['status'] });
  await flush(1);
  await answer(api, { status: status({ oid: 'c' }), undoState: { entries: [] } });
  assert.deepEqual(hashes(store), ['b', 'a'], 'the partial result is not applied with old refs');
  assert.deepEqual(pendingOps(api), { status: 1, refs: 1, stashes: 1, undoState: 1 });
  await answerRefresh(api, repoData({ commits: chain(['c', 'b', 'a']) }));
  assert.deepEqual(hashes(store), ['c', 'b', 'a']);
  assert.equal(store.state.status.oid, 'c');
});

test('watch: status reloads an open working-copy diff only when its file changed (or paths are unknown)', async () => {
  const dirty = repoData({ commits: chain(['b', 'a']), status: dirtyA() });
  const { api, store } = await loadedStore(dirty);
  store.actions.openDiff(wdSpec);
  api.take('workdirDiffView').resolve({ file: { path: 'a.txt', v: 1 }, fingerprint: 'f1' });
  await flush();

  const partial = async (e) => {
    store.actions.watchEvent({ repo: '/r', kinds: ['status'], ...e });
    await flush(1);
    await answer(api, { status: dirtyA(), undoState: { entries: [] } });
  };
  await partial({ paths: ['other.txt'] });
  assert.equal(api.pending('workdirDiffView').length, 0, 'another file changed: no reload');

  await partial({ paths: ['other.txt', 'a.txt'] });
  const r = api.take('workdirDiffView');
  assert.equal(store.state.diff.data.v, undefined);
  assert.equal(store.state.diff.data.file.v, 1, 'old data kept while reloading (same spec: scroll kept)');
  const spec = store.state.diff.spec;
  r.resolve({ file: { path: 'a.txt', v: 2 }, fingerprint: 'f2' });
  await flush();
  assert.equal(store.state.diff.spec, spec, 'same spec object: the diff view reloads in place');
  assert.equal(store.state.diff.data.fingerprint, 'f2');

  await partial({}); // paths unknown (index change, too many files)
  assert.equal(api.pending('workdirDiffView').length, 1, 'unknown paths: reload');
});

test('watch: status and stashes leave a commit diff alone', async () => {
  const { api, store } = await loadedStore(repoData({ commits: chain(['b', 'a']) }));
  store.actions.openDiff({ kind: 'commit', sha: 'b', file: 'x' });
  api.take('commitDiffView').resolve({ file: { path: 'x' } });
  await flush();
  store.actions.watchEvent({ repo: '/r', kinds: ['stashes', 'status'] });
  await flush(1);
  await answer(api, { status: status({ oid: 'b' }), stashes: [], undoState: { entries: [] } });
  assert.equal(api.pending('commitDiffView').length, 0);
  assert.ok(store.state.diff);
});

test('watch: events during an in-flight refresh coalesce into one re-run with the merged scope', async () => {
  const { api, store } = await loadedStore(repoData({ commits: chain(['b', 'a']) }));
  store.actions.refresh(); // e.g. focus
  await flush(1);
  store.actions.watchEvent({ repo: '/r', kinds: ['stashes'] });
  store.actions.watchEvent({ repo: '/r', kinds: ['status'], paths: ['a.txt'] });
  await flush(1);
  assert.deepEqual(pendingOps(api), { status: 1, refs: 1, stashes: 1, undoState: 1 }, 'nothing runs in parallel');
  // The in-flight refresh read old data; the re-run's newer data must win.
  await answerRefresh(api, repoData({ commits: chain(['b', 'a']) }));
  assert.deepEqual(pendingOps(api), { status: 1, stashes: 1, undoState: 1 }, 'one re-run: status + stashes');
  const list = [{ hash: 's1', index: 0 }];
  await answer(api, { status: dirtyA(), stashes: list, undoState: { entries: [] } });
  assert.deepEqual(rowKeys(store), ['WIP', 'b', 'a']);
  assert.deepEqual(store.state.stashes, list);
  assert.deepEqual(pendingOps(api), {});
});

test('watch: a full event while a partial refresh runs re-runs in full', async () => {
  const { api, store } = await loadedStore(repoData({ commits: chain(['b', 'a']) }));
  store.actions.watchEvent({ repo: '/r', kinds: ['stashes'] });
  await flush(1);
  store.actions.watchEvent({ repo: '/r', kinds: ['full'] });
  await flush(1);
  assert.deepEqual(pendingOps(api), { stashes: 1 });
  await answer(api, { stashes: [] });
  assert.deepEqual(pendingOps(api), { status: 1, refs: 1, stashes: 1, undoState: 1 });
});

test('watch: a status refresh does not disturb a loadMore page in flight', async () => {
  const next = { tips: ['b'], skip: 2 };
  const { api, store } = await loadedStore(repoData({ commits: chain(['b', 'a']), hasMore: true, next }));
  const pMore = store.actions.loadMore();
  await flush(1);
  const more = api.take('log', isMoreLog);
  store.actions.watchEvent({ repo: '/r', kinds: ['status'] });
  await flush(1);
  await answer(api, { status: dirtyA(), undoState: { entries: [] } });
  more.resolve({ commits: [commit('z')], hasMore: false, next: null });
  await pMore;
  await flush();
  assert.deepEqual(hashes(store), ['b', 'a', 'z'], 'the page is appended');
  assert.deepEqual(rowKeys(store), ['WIP', 'b', 'a', 'z']);
});

test('watch: a full event while loadMore is in flight never wipes the page', async () => {
  const next = { tips: ['b'], skip: 2 };
  const { api, store } = await loadedStore(repoData({ commits: chain(['b', 'a']), hasMore: true, next }));
  const pMore = store.actions.loadMore();
  await flush(1);
  const more = api.take('log', isMoreLog);
  store.actions.watchEvent({ repo: '/r', kinds: ['full'] });
  await flush(1);
  // HEAD moved: the refresh asks for the log, then the page lands before it answers.
  const moved = repoData({ commits: chain(['c', 'b', 'a']), hasMore: true, next: { tips: ['c'], skip: 3 } });
  const pending = api.pending('status').length;
  assert.equal(pending, 1);
  api.take('status').resolve(moved.status);
  api.take('refs').resolve(moved.refs);
  api.take('stashes').resolve([]);
  api.take('undoState').resolve({ entries: [] });
  await flush();
  const log = api.take('log', isRefreshLog);
  more.resolve({ commits: [commit('z')], hasMore: true, next: { tips: ['b'], skip: 3 } });
  await pMore;
  log.resolve(moved.log);
  await flush();
  // The log raced the page: dropped and re-run in full (never applied over the page).
  assert.deepEqual(hashes(store), ['b', 'a', 'z']);
  await answerRefresh(api, moved);
  assert.deepEqual(hashes(store), ['c', 'b', 'a']);
});

test('watch: gone and error show one notice each and keep the last state', async () => {
  const notices = [];
  const { api, store } = await loadedStore(repoData({ commits: chain(['b', 'a']) }));
  store.setToast((n) => notices.push(n));
  const before = api.calls.length;
  const rows = store.state.rows;
  store.actions.watchEvent({ repo: '/r', kinds: ['gone'] });
  store.actions.watchEvent({ repo: '/r', kinds: ['gone'] });
  assert.deepEqual(notices, [{ message: 'This repository was moved or deleted', level: 'info' }]);
  assert.equal(store.state.rows, rows);
  assert.equal(api.calls.length, before, 'nothing is read');

  store.actions.watchEvent({ repo: '/r', kinds: ['error'], error: 'ENOSPC: System limit for number of file watchers reached' });
  store.actions.watchEvent({ repo: '/r', kinds: ['error'], error: 'ENOSPC again' });
  assert.equal(notices.length, 2);
  assert.equal(notices[1].level, 'info');
  assert.match(notices[1].message, /^Auto-refresh is off \(ENOSPC: System limit.*\): .*regains focus$/);

  // Watching again (a retry worked): a later failure is notified again.
  store.actions.watchEvent({ repo: '/r', kinds: ['stashes'] });
  store.actions.watchEvent({ repo: '/r', kinds: ['error'] });
  assert.equal(notices.length, 3);
  assert.match(notices[2].message, /^Auto-refresh is off: /);
  await flush(1);
  await answer(api, { stashes: [] });

  // A new repo load resets it.
  const p = store.actions.loadRepo({ root: '/r', name: 'r' });
  await flush(1);
  await answerRefresh(api, repoData({ commits: chain(['b', 'a']) }));
  await p;
  store.actions.watchEvent({ repo: '/r', kinds: ['error'] });
  assert.equal(notices.length, 4);
});

test('watch: an event for the previous repo after a switch is ignored', async () => {
  const { api, store } = await loadedStore(repoData({ commits: chain(['b', 'a']) }));
  const p = store.actions.loadRepo({ root: '/other', name: 'other' });
  await flush(1);
  await answerRefresh(api, repoData({ commits: chain(['z']) }));
  await p;
  const before = api.calls.length;
  store.actions.watchEvent({ repo: '/r', kinds: ['full'] });
  await flush();
  assert.equal(api.calls.length, before);
});

// ------------------------------------------------------------------ rebase / merge in progress (docs/plans/rebase.md §5.4)

const midRebase = (oid, o = {}) => status({ oid, branch: null, state: 'rebasing', rebase: H.rebaseState({ stop: 'edit', conflicted: 0 }), ...o });

test('in progress: the WIP row stays with a clean tree (an edit stop), selected by default, and leaves with the rebase', async () => {
  const { api, store } = await loadedStore(repoData({ commits: chain(['b', 'a']), status: midRebase('b') }));
  assert.deepEqual(rowKeys(store), ['WIP', 'b', 'a'], 'clean tree, but a rebase is in progress');
  assert.deepEqual(store.state.selection, { kind: 'wip' });
  assert.equal(store.isDirty(), false);
  assert.equal(store.hasWip(), true);
  assert.equal(store.state.graph.rows.length, 3, 'the layout includes the WIP row');

  // the rebase finishes (terminal): same HEAD, clean -> the row goes and the selection falls back to HEAD
  store.actions.watchEvent({ repo: '/r', kinds: ['status'] });
  await flush(1);
  await answer(api, { status: status({ oid: 'b' }), undoState: { entries: [] } });
  assert.deepEqual(rowKeys(store), ['b', 'a']);
  assert.deepEqual(store.state.selection, { kind: 'commit', sha: 'b' });

  // a merge starts with the same HEAD: the layout key changes although the tree is clean
  store.actions.watchEvent({ repo: '/r', kinds: ['status'] });
  await flush(1);
  await answer(api, { status: status({ oid: 'b', state: 'merging', merge: { head: 'x', name: 'x', message: 'm' } }), undoState: { entries: [] } });
  assert.deepEqual(rowKeys(store), ['WIP', 'b', 'a']);
  assert.deepEqual(store.state.selection, { kind: 'commit', sha: 'b' }, 'an existing selection is kept');
  assert.equal(store.hasWip(status({ oid: 'b', state: 'clean' })), false);
  assert.equal(store.hasWip(status({ oid: 'b', state: 'bisecting' })), true);
  assert.equal(store.hasWip(null), false);
});

test('in progress: a WIP selection survives the step moving on (HEAD moves, tree stays clean)', async () => {
  const { api, store } = await loadedStore(repoData({ commits: chain(['b', 'a']), status: midRebase('b') }));
  assert.deepEqual(store.state.selection, { kind: 'wip' });
  store.actions.refresh();
  await flush(1);
  await answerRefresh(api, repoData({
    commits: chain(['c', 'b', 'a']),
    status: midRebase('c', { rebase: H.rebaseState({ stop: 'edit', conflicted: 0, step: { done: 3, total: 3 } }) }),
  }));
  assert.deepEqual(rowKeys(store), ['WIP', 'c', 'b', 'a']);
  assert.deepEqual(store.state.selection, { kind: 'wip' });
  assert.equal(store.state.graph.rows[0].column, 0, 'HEAD chain (through WIP) pinned to column 0');
});

test('continueDraft: null at first and after a repo switch; plain UI state otherwise', async () => {
  const { api, store } = await loadedStore(repoData({ commits: chain(['b']), status: midRebase('b') }));
  assert.equal(store.state.continueDraft, null);
  store.set({ continueDraft: { key: 'rebase:d', message: 'm' } });
  const p = store.actions.loadRepo({ root: '/s', name: 's' });
  assert.equal(store.state.continueDraft, null, 'reset with the repo');
  await flush(1);
  await answerRefresh(api, repoData({ commits: chain(['z']) }));
  await p;
});
