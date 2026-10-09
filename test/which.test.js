'use strict';
// src/which.js: the Windows path checks every absolute program path from the environment goes through.
const test = require('node:test');
const assert = require('node:assert/strict');
const { isDriveAbsolute, system32 } = require('../src/which');

test('isDriveAbsolute: only C:\\ or C:/ paths (never relative, drive-relative or UNC)', () => {
  for (const p of ['C:\\Windows', 'c:/Program Files', 'Z:\\']) assert.equal(isDriveAbsolute(p), true, p);
  for (const p of ['', null, undefined, 'Windows', '.\\evil', 'C:', 'C:Windows', '\\\\server\\share', '\\Windows', '/usr/bin']) {
    assert.equal(isDriveAbsolute(p), false, String(p));
  }
});

test('system32: from a drive-absolute SystemRoot, else C:\\Windows', () => {
  assert.equal(system32({ SystemRoot: 'D:\\Win' }), 'D:\\Win\\System32');
  assert.equal(system32({ SystemRoot: 'D:/Win/' }), 'D:\\Win\\System32');
  for (const env of [{}, null, { SystemRoot: '' }, { SystemRoot: 'Windows' }, { SystemRoot: '.\\evil' }, { SystemRoot: '\\\\server\\share' }]) {
    assert.equal(system32(env), 'C:\\Windows\\System32', JSON.stringify(env));
  }
});
