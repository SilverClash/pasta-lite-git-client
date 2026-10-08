'use strict';
// Keybindings: the one table (Components.actions.KEYS), its matcher (matchKey) and repeat policy
// (repeatBlocked), and what derives from it: PLFlows.shortcutFor / shortcutBlocked (the global
// shortcuts app.js runs, gated by Components.actions.availability like the toolbar), PLWip.shortcut
// (the WIP panel's) and the tooltip hints (keyHint).
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./renderer-harness.js');

/** Flows + the real Components.actions; `actions` replaces it (a fake) or, when null, removes it. */
function load({ actions } = {}) {
  H.setLocalStorage(H.memoryStorage());
  const win = H.loadFlows();
  if (actions === null) delete win.Components.actions;
  else if (actions) win.Components.actions = { ...win.Components.actions, ...actions };
  return win;
}

/** A keydown with the platform's command modifier (⌘ on macOS, Ctrl elsewhere). */
function key(win, k, extra = {}) {
  const mac = win.Components.util.IS_MAC;
  return { key: k, metaKey: mac, ctrlKey: !mac, shiftKey: false, altKey: false, repeat: false, isComposing: false, ...extra };
}

/** A keydown with ⌘ (mac) or Ctrl (!mac), whatever the platform. */
const press = (mac, k, extra = {}) => ({ key: k, metaKey: mac, ctrlKey: !mac, shiftKey: false, altKey: false, ...extra });

const REPO = { root: '/r', name: 'r' };
const ready = (extra = {}) => ({
  repo: REPO,
  busy: false,
  status: { ...H.status({ oid: 'a'.repeat(40), branch: 'main' }), upstream: 'origin/main' },
  refs: H.refs({ local: [{ name: 'main', oid: 'a'.repeat(40), upstream: 'origin/main', current: true }], remote: [{ name: 'origin/main', remote: 'origin', branch: 'main', oid: 'a'.repeat(40) }] }),
  remotes: ['origin'],
  stashes: [],
  undo: { undo: { description: 'Undo commit' }, redo: { description: 'Redo commit' }, busy: false, undoBlocked: null, redoBlocked: null },
  ...extra,
});

// ------------------------------------------------------------------ the table

test('KEYS: one frozen table of {id, key, shift, flow, args, gate, wip, inField, nav}; each entry has one handler at most', () => {
  const { KEYS } = load().Components.actions;
  assert.ok(Object.isFrozen(KEYS));
  assert.deepEqual(KEYS.map((k) => k.id), ['undo', 'redo', 'fetch', 'branch', 'stageAll', 'unstageAll', 'focusMessage', 'commit', 'commitAll', 'open', 'repoPicker']);
  for (const k of KEYS) {
    assert.ok(Object.isFrozen(k), k.id);
    assert.deepEqual(Object.keys(k).sort(), ['args', 'flow', 'gate', 'id', 'inField', 'key', 'nav', 'shift', 'wip'], k.id);
    assert.ok(Array.isArray(k.args) && Object.isFrozen(k.args), `${k.id}: frozen args`);
    if (!k.flow) assert.deepEqual(k.args, [], `${k.id}: args only with a flow`);
    assert.equal(k.key, k.key.toLowerCase(), `${k.id}: key in lower case`);
    assert.ok(!(k.flow && k.wip), `${k.id}: flow or wip, not both`);
    assert.equal(!!k.gate, !!k.flow, `${k.id}: a flow is gated`);
  }
  const combos = KEYS.map((k) => `${k.shift ? 'shift+' : ''}${k.key}`);
  assert.equal(new Set(combos).size, combos.length, 'no two entries share a key');
  const by = Object.fromEntries(KEYS.map((k) => [k.id, k]));
  assert.deepEqual(KEYS.filter((k) => k.flow).map((k) => [k.id, k.flow, k.gate, k.args]),
    [['undo', 'undo', 'undo', []], ['redo', 'redo', 'redo', []], ['fetch', 'fetch', 'fetch', []], ['branch', 'createBranch', 'branch', [{}]]],
    'app.js runs PLFlows[flow](store, ...args)');
  assert.deepEqual(KEYS.filter((k) => k.wip).map((k) => k.wip), ['stageAll', 'unstageAll', 'focusMessage', 'commit', 'commitAll']);
  assert.deepEqual(KEYS.filter((k) => !k.inField && (k.flow || k.wip)).map((k) => k.id), ['undo', 'redo', 'commit', 'commitAll'],
    'the field keeps ⌘Z / ⌘⇧Z; ⌘↵ in a text field only inside the commit fields');
  assert.deepEqual(KEYS.filter((k) => k.nav).map((k) => k.id), ['focusMessage'], 'only focus moves repeat');
  for (const id of ['open', 'repoPicker']) {
    assert.equal(by[id].flow || by[id].wip, null, `${id} is run by app.js itself (no flow / wip)`);
    assert.equal(by[id].inField, true, `${id} works in text fields`);
  }
  assert.deepEqual([by.open.key, by.open.shift, by.repoPicker.key, by.repoPicker.shift], ['o', false, 'p', false], '⌘O / ⌘P (⇧⌘O stays main\'s menu accelerator)');
});

test('VIEW_KEYS: the centre views\' single keys; no key twice in a view or between the diff and the image preview inside it', () => {
  const { VIEW_KEYS } = load().Components.actions;
  assert.ok(Object.isFrozen(VIEW_KEYS));
  assert.deepEqual(VIEW_KEYS.map((k) => `${k.view}:${k.id}`), [
    'diff:nextHunk', 'diff:prevHunk', 'diff:stageHunk', 'diff:unstageHunk', 'diff:closeDiff',
    'image:zoomIn', 'image:zoomOut', 'image:zoomFit', 'image:zoomActual', 'image:cycleMode',
  ]);
  for (const k of VIEW_KEYS) {
    assert.ok(Object.isFrozen(k) && Object.isFrozen(k.keys), k.id);
    assert.deepEqual(Object.keys(k).sort(), ['id', 'keys', 'view'], k.id);
  }
  const all = VIEW_KEYS.flatMap((k) => k.keys);
  assert.equal(new Set(all).size, all.length, 'the image keys work inside the diff view: no key is both');
  assert.equal(new Set(VIEW_KEYS.map((k) => k.id)).size, VIEW_KEYS.length);
  // The graph's own keys (graph-view.js) stay the graph's.
  for (const graphKey of ['j', 'k', 'ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp']) assert.ok(!all.includes(graphKey), graphKey);
});

test('matchViewKey / viewKeyHint: e.key as typed, never with ⌘ / Ctrl / Alt or while composing', () => {
  const { matchViewKey, viewKeyHint } = load().Components.actions;
  const k = (key, extra = {}) => ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, ...extra });
  assert.equal(matchViewKey(k('+', { shiftKey: true }), 'image').id, 'zoomIn', 'Shift as the layout needs it');
  assert.equal(matchViewKey(k('='), 'image').id, 'zoomIn');
  assert.equal(matchViewKey(k('-'), 'image').id, 'zoomOut');
  assert.equal(matchViewKey(k('0'), 'image').id, 'zoomFit');
  assert.equal(matchViewKey(k('1'), 'image').id, 'zoomActual');
  assert.equal(matchViewKey(k('m'), 'image').id, 'cycleMode');
  assert.equal(matchViewKey(k('M', { shiftKey: true }), 'image'), null, '⇧M is not m');
  assert.equal(matchViewKey(k('n'), 'image'), null, 'another view\'s key');
  assert.equal(matchViewKey(k('n'), 'diff').id, 'nextHunk');
  assert.equal(matchViewKey(k('Escape'), 'diff').id, 'closeDiff');
  for (const mod of ['metaKey', 'ctrlKey', 'altKey', 'isComposing']) assert.equal(matchViewKey(k('+', { [mod]: true }), 'image'), null, mod);
  assert.equal(matchViewKey(null, 'image'), null);
  assert.deepEqual(['zoomIn', 'zoomOut', 'cycleMode', 'closeDiff', 'nope'].map(viewKeyHint), ['+', '-', 'M', 'Esc', '']);
});

test('matchKey: ⌘ on macOS, Ctrl elsewhere; exact Shift; Caps Lock; repeats match', () => {
  const { KEYS, matchKey } = load().Components.actions;
  for (const mac of [true, false]) {
    for (const k of KEYS) {
      const e = press(mac, k.key === 'enter' ? 'Enter' : k.key.toUpperCase(), { shiftKey: k.shift });
      assert.equal(matchKey(e, { mac }), k, `${k.id} mac=${mac}`);
      assert.equal(matchKey({ ...e, key: e.key.toLowerCase() }, { mac }), k, `${k.id} lower case`);
      assert.equal(matchKey({ ...e, repeat: true }, { mac }), k, `${k.id} repeat`);
    }
    assert.equal(matchKey(press(mac, 's'), { mac }), null, '⌘S alone is not stage all');
    assert.equal(matchKey(press(mac, 'l', { shiftKey: true }), { mac }), null, '⌘⇧L');
    assert.equal(matchKey(press(mac, 'x'), { mac }), null, 'unknown key');
  }
});

test('matchKey: never without the modifier, with the other or both, with Alt, or while composing', () => {
  const { matchKey } = load().Components.actions;
  for (const mac of [true, false]) {
    const other = mac ? { ctrlKey: true, metaKey: false } : { metaKey: true, ctrlKey: false };
    assert.equal(matchKey({ key: 'z' }, { mac }), null);
    assert.equal(matchKey(press(mac, 'z', other), { mac }), null, `mac=${mac}: the other modifier alone`);
    assert.equal(matchKey(press(mac, 'z', mac ? { ctrlKey: true } : { metaKey: true }), { mac }), null, `mac=${mac}: both`);
    assert.equal(matchKey(press(mac, 'z', { altKey: true }), { mac }), null, 'Alt');
    assert.equal(matchKey(press(mac, 'Enter', { isComposing: true }), { mac }), null, 'IME');
  }
  assert.equal(matchKey(null), null);
  assert.equal(matchKey(undefined), null);
});

test('matchKey: the platform defaults to util.IS_MAC, read at call time', () => {
  const win = load();
  const { matchKey } = win.Components.actions;
  const util = win.Components.util;
  const saved = util.IS_MAC;
  try {
    for (const mac of [true, false]) {
      util.IS_MAC = mac;
      assert.equal(matchKey(press(mac, 'z')).id, 'undo', `mac=${mac}`);
      assert.equal(matchKey(press(!mac, 'z')), null, `mac=${mac}: the other platform's modifier`);
    }
  } finally {
    util.IS_MAC = saved;
  }
});

test('repeatBlocked: a held write key acts once; navigation (⌘⇧M) repeats; not a repeat -> false', () => {
  const win = load();
  const { repeatBlocked, matchKey } = win.Components.actions;
  const k = (name, extra) => key(win, name, extra);
  for (const [e, want, why] of [
    [k('z', { repeat: true }), true, '⌘Z held'],
    [k('Enter', { repeat: true }), true, '⌘↵ held'],
    [k('S', { shiftKey: true, repeat: true }), true, '⌘⇧S held'],
    [k('M', { shiftKey: true, repeat: true }), false, '⌘⇧M held: focus only'],
    [k('z'), false, 'first press'],
    [k('x', { repeat: true }), true, 'not a shortcut: a repeat still blocks'],
  ]) {
    assert.equal(repeatBlocked(e), want, why);
    assert.equal(repeatBlocked(e, matchKey(e)), want, `${why} (entry given)`);
  }
  assert.equal(repeatBlocked(null), false);
});

test('keyHint derives from KEYS: every entry has a hint on both platforms', () => {
  const { KEYS, keyHint } = load().Components.actions;
  const glyph = { enter: ['↵', 'Enter'] };
  for (const k of KEYS) {
    const [m, o] = glyph[k.key] || [k.key.toUpperCase(), k.key.toUpperCase()];
    assert.equal(keyHint(k.id, true), `${k.shift ? '⇧' : ''}⌘${m}`, k.id);
    assert.equal(keyHint(k.id, false), `Ctrl+${k.shift ? 'Shift+' : ''}${o}`, k.id);
    assert.equal(keyHint(k, true), keyHint(k.id, true), `${k.id}: the entry itself`);
  }
});

// ------------------------------------------------------------------ PLWip.shortcut

test('PLWip.shortcut: the KEYS entries with a wip action, and nothing else', () => {
  const win = load();
  const { KEYS } = win.Components.actions;
  const W = win.PLWip;
  for (const mac of [true, false]) {
    for (const k of KEYS) {
      const e = press(mac, k.key === 'enter' ? 'Enter' : k.key, { shiftKey: k.shift });
      assert.equal(W.shortcut(e, mac), k.wip, `${k.id} mac=${mac}`);
    }
  }
  assert.equal(W.shortcut(press(true, 'Enter'), false), null, '⌘↵ is not the modifier elsewhere');
  const noActions = load({ actions: null });
  assert.equal(noActions.PLWip.shortcut(press(true, 'Enter'), true), null, 'without Components.actions: no shortcuts');
});

// ------------------------------------------------------------------ PLFlows.shortcutFor

test('shortcutFor: the KEYS entries with a flow (⌘Z, ⌘⇧Z, ⌘L, ⌘B); nothing else', () => {
  const win = load();
  const F = win.PLFlows;
  const st = ready();
  assert.equal(F.shortcutFor(key(win, 'z'), st), 'undo');
  assert.equal(F.shortcutFor(key(win, 'Z', { shiftKey: true }), st), 'redo');
  assert.equal(F.shortcutFor(key(win, 'l'), st), 'fetch');
  assert.equal(F.shortcutFor(key(win, 'L'), st), 'fetch', 'Caps Lock');
  assert.equal(F.shortcutFor(key(win, 'b'), st), 'createBranch');
  assert.equal(F.shortcutFor(key(win, 'z', { repeat: true }), st), 'undo', 'a repeat matches: app.js swallows it (repeatBlocked)');
  for (const e of [key(win, 'S', { shiftKey: true }), key(win, 'Enter'), key(win, 'O', { shiftKey: true }), key(win, 'x'), { key: 'z' }, key(win, 'z', { altKey: true }), null]) {
    assert.equal(F.shortcutFor(e, st), null, JSON.stringify(e));
    assert.equal(F.shortcutBlocked(e, st), null, JSON.stringify(e));
  }
  assert.equal(F.shortcutFor(key(win, 'z'), { ...st, repo: null }), null, 'no repo');
});

test('shortcutFor: gated by Components.actions.availability (ctx passed through); shortcutBlocked gives the title', () => {
  const seen = [];
  const win = load({
    actions: {
      availability(state, ctx) {
        seen.push(ctx);
        return {
          undo: { disabled: false, title: 'Undo commit' },
          redo: { disabled: true, title: 'Nothing to redo' },
          fetch: { disabled: true, title: 'Fetch — no remotes' },
          branch: { disabled: true, title: '' },
        };
      },
    },
  });
  const F = win.PLFlows;
  const st = ready();
  const ctx = { dirty: true, pullMode: 'rebase' };
  assert.equal(F.shortcutFor(key(win, 'z'), st, ctx), 'undo');
  assert.equal(F.shortcutBlocked(key(win, 'z'), st, ctx), null, 'enabled: nothing blocked');
  assert.equal(F.shortcutFor(key(win, 'z', { shiftKey: true }), st, ctx), null);
  assert.equal(F.shortcutBlocked(key(win, 'z', { shiftKey: true }), st, ctx), 'Nothing to redo');
  assert.equal(F.shortcutFor(key(win, 'l'), st, ctx), null);
  assert.equal(F.shortcutBlocked(key(win, 'l'), st, ctx), 'Fetch — no remotes');
  assert.equal(F.shortcutFor(key(win, 'b'), st, ctx), null);
  assert.equal(F.shortcutBlocked(key(win, 'b'), st, ctx), 'Not available right now', 'a fallback title');
  assert.deepEqual(seen[0], ctx);
});

test('shortcutFor with the real availability: ⌘B on an unborn repo, ⌘L without remotes, ⌘Z with nothing to undo, busy', () => {
  const win = load();
  const F = win.PLFlows;
  const ctx = { dirty: false, pullMode: 'ff-if-possible' };
  const st = ready();
  assert.equal(F.shortcutFor(key(win, 'b'), st, ctx), 'createBranch');
  assert.equal(F.shortcutFor(key(win, 'l'), st, ctx), 'fetch');
  assert.equal(F.shortcutFor(key(win, 'z'), st, ctx), 'undo');

  const unborn = ready({ status: { ...H.status({ oid: null, branch: 'main' }), upstream: null }, refs: H.refs() });
  assert.equal(F.shortcutFor(key(win, 'b'), unborn, ctx), null);
  assert.ok(F.shortcutBlocked(key(win, 'b'), unborn, ctx));

  const noRemotes = ready({ remotes: [], refs: H.refs({ local: [{ name: 'main', oid: 'a'.repeat(40), upstream: null, current: true }] }) });
  assert.equal(F.shortcutFor(key(win, 'l'), noRemotes, ctx), null);
  assert.match(F.shortcutBlocked(key(win, 'l'), noRemotes, ctx), /remote/i);

  const nothing = ready({ undo: { undo: null, redo: null, busy: false, undoBlocked: null, redoBlocked: null } });
  assert.equal(F.shortcutFor(key(win, 'z'), nothing, ctx), null);
  assert.match(F.shortcutBlocked(key(win, 'z'), nothing, ctx), /Nothing to undo/);

  assert.equal(F.shortcutFor(key(win, 'z'), ready({ busy: true }), ctx), null, 'busy');
});

test('shortcutFor without Components.actions: no shortcuts (the table lives there)', () => {
  const win = load({ actions: null });
  assert.equal(win.PLFlows.shortcutFor(key(win, 'b'), ready()), null);
  assert.equal(win.PLFlows.shortcutBlocked(key(win, 'b'), ready()), null);
});

test('shortcutFor: in a text field (ctx.inField) ⌘Z / ⌘⇧Z stay the field\'s own; ⌘L / ⌘B still run', () => {
  const win = load();
  const F = win.PLFlows;
  const st = ready();
  const ctx = { dirty: false, pullMode: 'ff-if-possible', inField: true };
  assert.equal(F.shortcutFor(key(win, 'z'), st, ctx), null);
  assert.equal(F.shortcutFor(key(win, 'z', { shiftKey: true }), st, ctx), null);
  assert.equal(F.shortcutBlocked(key(win, 'z'), ready({ undo: null }), ctx), null, 'no notice either: the field handles ⌘Z');
  assert.equal(F.shortcutFor(key(win, 'l'), st, ctx), 'fetch');
  assert.equal(F.shortcutFor(key(win, 'b'), st, ctx), 'createBranch');
  const noRemotes = ready({ remotes: [], refs: H.refs({ local: [{ name: 'main', oid: 'a'.repeat(40), upstream: null, current: true }] }) });
  assert.match(F.shortcutBlocked(key(win, 'l'), noRemotes, ctx), /remote/i, 'gated in a field too');
  assert.equal(F.shortcutFor(key(win, 'z'), st, { ...ctx, inField: false }), 'undo');
});

test('shortcutFor: Ctrl on other platforms (⌘ / the Windows key is not the modifier there)', () => {
  const win = load();
  const F = win.PLFlows;
  const util = win.Components.util;
  const st = ready();
  const saved = util.IS_MAC;
  try {
    for (const mac of [true, false]) {
      util.IS_MAC = mac;
      const cmd = mac ? { metaKey: true } : { ctrlKey: true };
      const other = mac ? { ctrlKey: true } : { metaKey: true };
      const k = (k2, extra = {}) => ({ key: k2, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, ...extra });
      assert.equal(F.shortcutFor(k('z', cmd), st), 'undo', `mac=${mac}`);
      assert.equal(F.shortcutFor(k('Z', { ...cmd, shiftKey: true }), st), 'redo', `mac=${mac}`);
      assert.equal(F.shortcutFor(k('l', cmd), st), 'fetch', `mac=${mac}`);
      assert.equal(F.shortcutFor(k('b', cmd), st), 'createBranch', `mac=${mac}`);
      assert.equal(F.shortcutFor(k('z', other), st), null, `mac=${mac}: the other modifier alone`);
      assert.equal(F.shortcutFor(k('z', { ...cmd, ...other }), st), null, `mac=${mac}: both`);
    }
  } finally {
    util.IS_MAC = saved;
  }
});

test('shortcutFor mid-rebase / merge: ⌘B and ⌘Z are blocked with the reason, ⌘L still fetches', () => {
  const win = load();
  const F = win.PLFlows;
  const st = ready({ status: { ...H.status({ oid: 'a'.repeat(40), branch: null, state: 'rebasing', rebase: H.rebaseState() }), upstream: 'origin/main' } });
  assert.equal(F.shortcutFor(key(win, 'b'), st, {}), null);
  assert.equal(F.shortcutBlocked(key(win, 'b'), st, {}), 'Branch — finish or abort the rebase first');
  assert.equal(F.shortcutFor(key(win, 'z'), st, {}), null);
  assert.equal(F.shortcutBlocked(key(win, 'z'), st, {}), 'Undo is unavailable while a rebase is in progress');
  assert.equal(F.shortcutFor(key(win, 'l'), st, {}), 'fetch');
  const merging = ready({ status: { ...H.status({ oid: 'a'.repeat(40), state: 'merging' }), upstream: 'origin/main' } });
  assert.equal(F.shortcutBlocked(key(win, 'b'), merging, {}), 'Branch — finish or abort the merge first');
  assert.equal(F.shortcutFor(key(win, 'b'), ready(), {}), 'createBranch', 'clean: unchanged');
});
