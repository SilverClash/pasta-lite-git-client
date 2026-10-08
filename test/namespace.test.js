'use strict';
// src/namespace.js holds the names the app owns in a repository; the shell commands of
// src/rebase-editor.js (git's editor) spell the state folder and the refusal marker from it.
const test = require('node:test');
const assert = require('node:assert/strict');
const ns = require('../src/namespace');
const editor = require('../src/rebase-editor');

test("the rebase editor's commands use namespace.js's names", () => {
  for (const cmd of [editor.TODO_EDITOR, editor.MSG_EDITOR]) {
    assert.ok(cmd.includes(`s=$d/${ns.PL_DIR}/${ns.REBASE_DIR}`), 'the state folder <git-dir>/pasta-lite/rebase');
    assert.ok(cmd.includes(`[ ! -L "$d/${ns.PL_DIR}" ]`), 'the plain-folder check of <git-dir>/pasta-lite');
    assert.ok(cmd.includes(`'${ns.HELPER_REFUSED}: '`), 'the refusal marker git-errors.helperRefused reads');
  }
});

test('the refs sit in our namespaces', () => {
  for (const ref of [ns.AUTOSTASH_REF, ns.LEGACY_AUTOSTASH_REF, ns.BACKUP_REF]) {
    assert.ok(ns.REF_NAMESPACES.some((p) => ref.startsWith(p)), ref);
  }
  assert.ok(ns.AUTOSTASH_REF.startsWith('refs/worktree/'), 'per worktree');
});
