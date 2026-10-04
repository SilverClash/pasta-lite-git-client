'use strict';
// One tab's session (src/tab-session.js) over a fake createWatcher: the repo, openSeq (which open
// wins), the watcher following the repo (root and bare mode), closing and closed.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createTabSession, watchesBare } = require('../src/tab-session');

const repo = (root, o = {}) => ({ root, name: root.split('/').pop(), head: { sha: 'a'.repeat(40), branch: 'main' }, bare: false, ...o });

function setup({ running = [] } = {}) {
  const made = []; // fake watchers: {root, bare, onEvent, pauses, resumes, closed}
  const sent = [];
  const gone = [];
  const createWatcher = (root, { onEvent, bare }) => {
    const w = { root, bare, onEvent, pauses: 0, resumes: 0, closed: false, pause() { w.pauses++; }, resume() { w.resumes++; }, close() { w.closed = true; } };
    made.push(w);
    return w;
  };
  const s = createTabSession({
    id: 7,
    send: (channel, payload) => sent.push([channel, payload]),
    createWatcher,
    runnerRunning: () => running,
    onGone: (x) => gone.push(x),
    log: () => {},
    watch: { info: () => {} },
  });
  return { s, made, sent, gone, last: () => made[made.length - 1] };
}

describe('setRepo: the watcher follows the repo', () => {
  test('a repo opens a watcher for its root, in its bare mode; null closes it; changed = root, name or bare', () => {
    const { s, made, last } = setup();
    assert.equal(s.repo, null);
    assert.equal(s.setRepo(repo('/r/a')), true);
    assert.equal(last().root, '/r/a');
    assert.equal(last().bare, false);
    assert.equal(s.watch.root, '/r/a');
    assert.equal(s.setRepo(repo('/r/a', { head: { sha: 'b'.repeat(40), branch: 'x' } })), false, 'same root, name, bare: unchanged');
    assert.equal(made.length, 2, 'every open replaces the watcher (and resets its backoff)');
    assert.equal(made[0].closed, true);
    assert.equal(s.setRepo(repo('/w/.bare', { name: 'w/.bare', bare: true })), true);
    assert.equal(last().bare, true, 'a bare repo is watched as a git dir');
    assert.equal(s.setRepo(null), true);
    assert.equal(last().closed, true);
    assert.equal(s.watch.root, null);
    assert.equal(s.setRepo(null), false);
  });

  test('a new session starts paused (background tab) and paused for writes already running', () => {
    const { s, last } = setup({ running: [{ repo: '/r/a', write: true, started: true }, { repo: '/r/a', write: false, started: true }, { repo: '/r/a', write: true, started: false }] });
    assert.equal(s.watch.paused, true);
    s.setRepo(repo('/r/a'));
    assert.equal(last().pauses, 2, 'one for the background, one for the running write (not the read, not the queued write)');
  });

  test('watchesBare: only for the tab repo\'s own root, when it is bare', () => {
    assert.equal(watchesBare({ root: '/w/.bare', bare: true }, '/w/.bare'), true);
    assert.equal(watchesBare({ root: '/w/.bare', bare: true }, '/w/main'), false, 'another root');
    assert.equal(watchesBare({ root: '/w/main', bare: false }, '/w/main'), false);
    assert.equal(watchesBare(null, '/w/.bare'), false);
  });
});

describe('refresh (app:getState\'s fresh summary)', () => {
  test('a new head is stored without touching the watcher', () => {
    const { s, made } = setup();
    s.setRepo(repo('/r/a'));
    const fresh = repo('/r/a', { head: { sha: 'c'.repeat(40), branch: 'dev' } });
    assert.equal(s.refresh(fresh), false);
    assert.equal(s.repo, fresh);
    assert.equal(made.length, 1);
  });

  test('bug fix: a bare flag that flipped reaches the watcher\'s mode and reports a change (strip, title)', () => {
    const { s, last, made } = setup();
    s.setRepo(repo('/r/a'));
    assert.equal(last().bare, false);
    assert.equal(s.refresh(repo('/r/a', { bare: true })), true);
    assert.equal(made.length, 2);
    assert.equal(made[0].closed, true);
    assert.equal(last().bare, true, 'the new watcher treats every path as a git one');
    assert.equal(s.repo.bare, true);
  });

  test('bug fix: a changed name reports a change (the strip and the window title show it)', () => {
    const { s } = setup();
    s.setRepo(repo('/r/a'));
    assert.equal(s.refresh(repo('/r/a', { name: 'renamed' })), true);
    assert.equal(s.repo.name, 'renamed');
  });

  test('a folder that became (or stopped being) a linked worktree reports a change (the strip\'s title and icon)', () => {
    const { s } = setup();
    const lw = { mainPath: '/r/main', mainName: 'main', title: 'main · a' };
    s.setRepo(repo('/r/a', { linkedWorktree: null }));
    assert.equal(s.refresh(repo('/r/a', { linkedWorktree: lw })), true);
    assert.equal(s.refresh(repo('/r/a', { linkedWorktree: { ...lw } })), false, 'equal content: unchanged');
    assert.equal(s.refresh(repo('/r/a', { linkedWorktree: { ...lw, mainPath: '/r/other' } })), true);
    assert.equal(s.refresh(repo('/r/a')), true, 'no longer linked');
  });

  test('another root, no repo, or a closed tab: ignored', () => {
    const { s } = setup();
    assert.equal(s.refresh(repo('/r/a')), false);
    assert.equal(s.repo, null);
    s.setRepo(repo('/r/a'));
    assert.equal(s.refresh(repo('/r/b')), false);
    assert.equal(s.repo.root, '/r/a');
    s.close();
    assert.equal(s.refresh(repo('/r/a', { bare: true })), false);
  });
});

describe('openSeq: which open wins', () => {
  test('a newer open from the tab makes the older one stale', () => {
    const { s } = setup();
    const a = s.beginOpen();
    const b = s.beginOpen();
    assert.equal(a.stale(), true);
    assert.equal(b.stale(), false);
  });

  test('bug fix: an open that landed in the tab from elsewhere (CLI, dock) makes a pending one stale', () => {
    const { s } = setup();
    const pending = s.beginOpen(); // e.g. waiting on the Trust and Open dialog
    s.setRepo(repo('/r/external'));
    assert.equal(pending.stale(), true, 'the pending open must not replace the repo that landed meanwhile');
  });

  test('a refresh with the same name and bare flag, or a repo closing, leaves a pending open alone', () => {
    const { s } = setup();
    s.setRepo(repo('/r/a'));
    const pending = s.beginOpen();
    s.refresh(repo('/r/a', { head: { sha: 'd'.repeat(40), branch: 'x' } }));
    assert.equal(pending.stale(), false);
    s.setRepo(null);
    assert.equal(pending.stale(), false);
  });

  test('closing the tab makes every pending open stale', () => {
    const { s } = setup();
    const pending = s.beginOpen();
    s.close();
    assert.equal(pending.stale(), true);
  });
});

describe('gone, close', () => {
  test('the watched folder is gone: the page gets the event, the repo closes, onGone runs', () => {
    const { s, sent, gone, last } = setup();
    s.setRepo(repo('/r/a'));
    s.watch.resume();
    last().onEvent({ kinds: ['gone'] });
    assert.deepEqual(sent, [['watch', { repo: '/r/a', kinds: ['gone'] }]]);
    assert.equal(s.repo, null);
    assert.deepEqual(gone, [s]);
  });

  test('close: the watcher closes, nothing is sent any more, setRepo does nothing', () => {
    const { s, sent, last, made } = setup();
    s.setRepo(repo('/r/a'));
    s.watch.resume();
    s.close();
    assert.equal(s.closed, true);
    assert.equal(last().closed, true);
    last().onEvent({ kinds: ['status'] });
    s.send('repo-opened', {});
    assert.deepEqual(sent, []);
    assert.equal(s.setRepo(repo('/r/b')), false);
    assert.equal(made.length, 1, 'no watcher for a closed tab');
    s.close(); // idempotent
  });

  test('beginClose / endClose: one close decision at a time; none once closed', () => {
    const { s } = setup();
    assert.equal(s.beginClose(), true);
    assert.equal(s.closing, true);
    assert.equal(s.beginClose(), false);
    s.endClose();
    assert.equal(s.closing, false);
    s.close();
    assert.equal(s.beginClose(), false);
  });
});
