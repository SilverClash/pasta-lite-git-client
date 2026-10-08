'use strict';
// src/repo-trust.js: the Trust and Open wording and the policy (trusted earlier, asked, declined,
// refused without a UI, a trust store that can't be written).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRepoTrust, describeRiskyConfig } = require('../src/repo-trust');


test('describeRiskyConfig names the repo and lists every key', () => {
  const { message, detail } = describeRiskyConfig('/r/my repo', ['core.sshcommand', 'filter.x.clean']);
  assert.match(message, /"my repo" has settings that run commands/);
  assert.match(detail, /\/r\/my repo/);
  assert.match(detail, /^ {2}core\.sshcommand$/m);
  assert.match(detail, /^ {2}filter\.x\.clean$/m);
  assert.doesNotMatch(detail, /hooks/);
});

test('describeRiskyConfig lists a bare repo\'s hooks apart from its config keys', () => {
  const { detail } = describeRiskyConfig('/r/e.git', ['hooks/reference-transaction']);
  assert.match(detail, /^The repository \(\/r\/e\.git\) has hooks that git runs:$/m);
  assert.match(detail, /^ {2}hooks\/reference-transaction$/m);
  assert.doesNotMatch(detail, /git config/, 'no config section without config keys');
  const both = describeRiskyConfig('/r/e.git', ['core.sshcommand', 'hooks/pre-push']).detail;
  assert.ok(both.indexOf('core.sshcommand') < both.indexOf('has hooks') && both.indexOf('has hooks') < both.indexOf('hooks/pre-push'));
});

test('describeRiskyConfig lists submodules\' and other worktrees\' entries under their own heading, one line each', () => {
  const { message, detail } = describeRiskyConfig('/r/a\nb', ['filter.x.clean', 'submodule lib: hooks/post-checkout', 'worktree worktrees/wt: filter.y.clean', 'submodule x\ny: filter.z.clean']);
  assert.equal(message.includes('\n'), false, 'a newline in the folder name is not a new line');
  assert.match(detail, /^Its submodules or other worktrees have their own settings or hooks that run commands:$/m);
  assert.match(detail, /^ {2}submodule lib: hooks\/post-checkout$/m);
  assert.match(detail, /^ {2}worktree worktrees\/wt: filter\.y\.clean$/m);
  assert.match(detail, /^ {2}submodule x\?y: filter\.z\.clean$/m);
  assert.doesNotMatch(detail, /has hooks that git runs/, 'a submodule\'s hook is not the repository\'s own');
  assert.ok(detail.indexOf('  filter.x.clean') < detail.indexOf('Its submodules'));
});

// ---------------------------------------------------------------- the policy

/** A trust over fake git checks (`config` / `hooks` keys per root), a fake store and dialog. */
function setup({ config = [], hooks = [], nested = [], trusted = {}, answers = [], interactive = true, trustThrows = false } = {}) {
  const asked = [];
  const saved = [];
  const records = [];
  const store = {
    isTrusted: (root, keys) => keys.every((k) => (trusted[root] || []).includes(k)),
    trust: (root, keys) => { if (trustThrows) throw new Error('EACCES'); saved.push([root, keys]); },
  };
  const trust = createRepoTrust({
    git: { riskyLocalConfig: async () => config, riskyHooks: async () => hooks, riskyNested: async () => nested },
    store: () => store,
    ui: { interactive, confirm: async (opts) => { asked.push(opts); return answers.shift(); } },
    log: { info: (msg, f) => records.push(['info', msg, f]), warn: (msg, f) => records.push(['warn', msg, f]) },
  });
  return { trust, asked, saved, records };
}

test('no risky keys: opens without asking; hooks ask like config keys, bare or not', async () => {
  const t = setup();
  assert.equal(await t.trust.confirm('/r/a'), true);
  assert.equal(t.asked.length, 0);
  const u = setup({ hooks: ['hooks/pre-commit'] });
  assert.equal(await u.trust.confirm('/r/a'), false, 'the hook asks (no answer = declined)');
  assert.equal(u.asked.length, 1);
  assert.match(u.asked[0].detail, /^ {2}hooks\/pre-commit$/m);
});

test('a submodule\'s or another worktree\'s entries ask like the repo\'s own, and are remembered with them', async () => {
  const t = setup({ config: ['core.sshcommand'], nested: ['submodule lib: filter.x.clean'], answers: [true] });
  assert.equal(await t.trust.confirm('/r/a'), true);
  assert.equal(t.asked.length, 1);
  assert.match(t.asked[0].detail, /^ {2}submodule lib: filter\.x\.clean$/m);
  assert.deepEqual(t.saved, [['/r/a', ['core.sshcommand', 'submodule lib: filter.x.clean']]]);
  const u = setup({ nested: ['worktree worktrees/wt: filter.y.clean'], trusted: { '/r/a': ['core.sshcommand'] }, answers: [false] });
  assert.equal(await u.trust.confirm('/r/a'), false, 'trusted for other keys only: asks again');
  assert.equal(u.asked.length, 1);
});

test('trusted earlier for every key: opens without asking; a new key asks again', async () => {
  const t = setup({ config: ['core.fsmonitor'], trusted: { '/r/a': ['core.fsmonitor'] } });
  assert.equal(await t.trust.confirm('/r/a'), true);
  assert.equal(t.asked.length, 0);
  assert.deepEqual(t.records, [['info', 'repo config runs commands: trusted earlier', { repo: '/r/a', risky: ['core.fsmonitor'] }]]);
  const u = setup({ config: ['core.fsmonitor'], hooks: ['hooks/post-checkout'], trusted: { '/r/a': ['core.fsmonitor'] }, answers: [false] });
  assert.equal(await u.trust.confirm('/r/a'), false);
  assert.equal(u.asked.length, 1);
});

test('asked: Trust and Open remembers the keys; Cancel (the default) declines and saves nothing', async () => {
  const yes = setup({ config: ['filter.x.clean'], answers: [true] });
  assert.equal(await yes.trust.confirm('/r/a'), true);
  assert.deepEqual(yes.saved, [['/r/a', ['filter.x.clean']]]);
  const opts = yes.asked[0];
  assert.deepEqual(opts.buttons, ['Trust and Open', 'Cancel']);
  assert.equal(opts.defaultId, 1);
  assert.equal(opts.cancelId, 1);
  assert.equal(opts.type, 'warning');
  assert.equal(opts.message, describeRiskyConfig('/r/a', ['filter.x.clean']).message);
  const no = setup({ config: ['filter.x.clean'], answers: [false] });
  assert.equal(await no.trust.confirm('/r/a'), false);
  assert.deepEqual(no.saved, []);
  assert.deepEqual(no.records.at(-1), ['info', 'repo config runs commands: declined', { repo: '/r/a', risky: ['filter.x.clean'] }]);
});

test('a trust store that cannot be written: opens this time, logged', async () => {
  const t = setup({ config: ['filter.x.clean'], answers: [true], trustThrows: true });
  assert.equal(await t.trust.confirm('/r/a'), true);
  assert.equal(t.records.at(-1)[1], 'could not save the trusted repositories');
});

test('not interactive (smoke): never asks, refuses with kind untrusted naming the keys', async () => {
  const t = setup({ config: ['filter.x.clean', 'filter.x.smudge'], interactive: false });
  await assert.rejects(t.trust.confirm('/r/a'), (e) => e.kind === 'untrusted' && /config runs commands \(filter\.x\.clean, filter\.x\.smudge\)/.test(e.message));
  assert.equal(t.asked.length, 0);
});
