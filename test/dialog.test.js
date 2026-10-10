'use strict';
// The shared modal of renderer/dialog.js (Components.dialog.modal) and its onDismiss veto, on the
// harness's fake DOM: what the clone dialog's progress relies on (only its Cancel button cancels).
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./renderer-harness');

function setup() {
  const dom = H.fakeDom().install();
  const win = H.loadComponentHelpers();
  dom.attach(win);
  return { dom, D: win.Components.dialog };
}
const backdropOf = (buttonEl) => buttonEl.closest('.dlg-backdrop');

test('modal is exported; Esc and a backdrop press cancel it as before when there is no veto', async () => {
  const { dom, D } = setup();
  assert.equal(typeof D.modal, 'function');
  const a = D.modal({ title: 'A', buttons: [{ label: 'Go', value: 'go' }], cancelValue: 'esc' });
  dom.key('Escape');
  assert.equal(await a.promise, 'esc');
  const b = D.modal({ title: 'B', buttons: [{ label: 'Go', value: 'go' }], cancelValue: 'backdrop', onDismiss: () => undefined });
  dom.dispatch(backdropOf(b.buttons[0]), 'mousedown');
  assert.equal(await b.promise, 'backdrop');
  assert.equal(D.isOpen(), false);
});

test('onDismiss false keeps the dialog open on Esc and on a backdrop press; its buttons still work', async () => {
  const { dom, D } = setup();
  let asked = 0;
  const m = D.modal({ title: 'Running', buttons: [{ label: 'Stop', value: 'stop' }], cancelValue: 'x', onDismiss: () => { asked++; return false; } });
  const e = dom.key('Escape');
  assert.equal(e.defaultPrevented, true, 'Esc is still the dialog\'s: nothing behind it gets it');
  dom.dispatch(backdropOf(m.buttons[0]), 'mousedown');
  assert.equal(asked, 2);
  assert.equal(D.isOpen(), true);
  assert.ok(m.buttons[0].isConnected);
  m.buttons[0].click();
  assert.equal(await m.promise, 'stop');
});

test('a forced close (another dialog opening, or close()) still closes a vetoing dialog', async () => {
  const { D } = setup();
  const m = D.modal({ title: 'Running', buttons: [{ label: 'Stop', value: 'stop' }], cancelValue: 'forced', onDismiss: () => false });
  const other = D.confirm({ title: 'Something else' });
  assert.equal(await m.promise, 'forced');
  assert.equal(m.buttons[0].isConnected, false);
  D.close();
  assert.equal(await other, false);
  const n = D.modal({ title: 'Again', buttons: [{ label: 'Stop', value: 'stop' }], cancelValue: 'closed', onDismiss: () => false });
  D.close();
  assert.equal(await n.promise, 'closed');
});
