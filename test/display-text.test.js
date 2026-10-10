'use strict';
// The invisible-character class and displayName (src/display-text.js), shared by the renderer
// (Components.util.displayName; its cases stay in test/renderer-util.test.js) and main's clone parsers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { INVISIBLE, hasInvisible, displayName } = require('../src/display-text');
const { loadRenderer } = require('./renderer-harness');

const ch = (n) => String.fromCharCode(n);

test('INVISIBLE: C0 and C1 controls, DEL and the bidi controls; ordinary text is left alone', () => {
  const invisible = [0x00, 0x09, 0x0a, 0x0d, 0x1b, 0x1f, 0x7f, 0x80, 0x9f, 0x00ad, 0x061c, 0x180e, 0x200b, 0x200e, 0x200f, 0x202a, 0x202e,
    0x2060, 0x2061, 0x2064, 0x2066, 0x2069, 0xfeff, 0xfff9, 0xfffb];
  for (const c of invisible) assert.equal(hasInvisible(`a${ch(c)}b`), true, c.toString(16));
  for (const s of ['plain', 'caf\u00e9', 'a b', 'a\u200db']) assert.equal(hasInvisible(s), false, s);
  assert.equal(`x${ch(0x202e)}y${ch(0x1b)}`.replace(INVISIBLE, ''), 'xy');
});

test('hasInvisible keeps no state between calls (INVISIBLE is a global regex)', () => {
  const s = `ab${ch(0x07)}`;
  for (let i = 0; i < 4; i++) assert.equal(hasInvisible(s), true, `call ${i}`);
});

test('displayName escapes what INVISIBLE matches, and is the function the renderer uses', () => {
  assert.equal(displayName(`rtl${ch(0x202e)}gnp.js`), 'rtl\\u{202E}gnp.js');
  assert.equal(displayName('a\nb\tc'), `a${ch(0x21b5)}b${ch(0x21e5)}c`);
  assert.equal(displayName(null), '');
  const win = loadRenderer();
  assert.equal(win.Components.util.displayName(`x${ch(0x00)}`), 'x\\u{0000}');
  assert.equal(win.Components.util.displayName, win.PLDisplayText.displayName, 'one definition');
});

test('the UMD file works as a plain browser script (window.PLDisplayText)', () => {
  const vm = require('node:vm');
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'display-text.js'), 'utf8'), { window });
  assert.equal(window.PLDisplayText.displayName(`a${ch(0x202e)}`), 'a\\u{202E}');
  assert.equal(window.PLDisplayText.hasInvisible('ok'), false);
});

test('index.html loads the shared scripts in order: display-text, path-names, clone-url, then components.js', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const at = (src) => html.indexOf(`<script src="${src}"></script>`);
  const order = ['../src/error-kinds.js', '../src/display-text.js', '../src/path-names.js', '../src/clone-url.js', 'components.js'].map(at);
  assert.ok(order.every((i) => i >= 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test('the joiners (ZWNJ, ZWJ) stay in shown text, and count only when asked (URLs, folder names)', () => {
  for (const c of [0x200c, 0x200d]) {
    assert.equal(hasInvisible(`a${ch(c)}b`), false, c.toString(16));
    assert.equal(hasInvisible(`a${ch(c)}b`, { joiners: true }), true, c.toString(16));
    assert.equal(displayName(`a${ch(c)}b`), `a${ch(c)}b`, 'emoji sequences and Persian or Indic words keep them');
  }
  assert.equal(displayName(`a${ch(0x200b)}b`), 'a\\u{200B}b');
  assert.equal(hasInvisible('plain', { joiners: true }), false);
});
