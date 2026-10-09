'use strict';
// src/redact.js: every secret class, realistic git error output, nested values, Errors, caps, and
// that ordinary text is left alone.
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../src/redact');

const { redact, redactString: rs, redactError, summarizeArgs } = R;

// A fixed home for the '~' rule (restored after the file), with POSIX rules whatever the host:
// on Windows it would match in any case. The Windows rules have their own test.
R._internal.setHome('/Users/ada', { platform: 'darwin' });
test.after(() => R._internal.setHome());

// Fake fixtures, assembled at runtime so no complete token-shaped literal sits in the source
// (secret scanners such as GitHub push protection, gitleaks and trufflehog would flag it).
const GHP = 'ghp' + '_1234567890abcdefghijABCDEFGHIJ123456';
const GHO = 'gho' + '_abcdefghijklmnopqrstuvwxyz0123456789';
const GHU = 'ghu' + '_abcdefghijklmnopqrstuvwxyz';
const GHS = 'ghs' + '_abcdefghijklmnopqrstuvwxyz';
const PAT = 'github' + '_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV';
const PAT_SHORT = 'github' + '_pat_AbC_123_dEf_456_gHi_789_jKl';
const GLPAT = 'glpat' + '-xY9zAbCdEfGhIjKlMnOp';
const GLPAT_A = 'glpat' + '-' + 'a'.repeat(20);
const AKIA = 'AKIA' + 'ABCDEFGHIJKLMNOP';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.' + 'eyJzdWIiOiIxIn0.abc';
/** A PEM armour line, e.g. pem('BEGIN', 'RSA ') gives the RSA BEGIN armour line. */
const pem = (edge, kind = '') => `-----${edge} ${kind}PRIVATE` + ' KEY-----';

/** The redacted form must contain none of `secrets`. */
function clean(out, ...secrets) {
  const s = typeof out === 'string' ? out : JSON.stringify(out);
  for (const x of secrets) assert.ok(!s.includes(x), `leaked ${x} in ${s}`);
  return s;
}

// ---------------------------------------------------------------- URLs

test('credentials in URLs: user:token, token only, any scheme', () => {
  assert.equal(rs('https://ada:s3cret@github.com/org/repo.git'), 'https://***@github.com/org/repo.git');
  assert.equal(rs(`https://${GHP}@github.com/org/repo.git`), 'https://***@github.com/org/repo.git');
  assert.equal(rs('https://oauth2:abc123@gitlab.example.com:8443/g/p'), 'https://***@gitlab.example.com:8443/g/p');
  assert.equal(rs('ssh://git@github.com/org/repo'), 'ssh://***@github.com/org/repo');
  assert.equal(rs('HTTP://X:Y@host/'), 'HTTP://***@host/');
  // Percent-encoded and odd characters in the password.
  clean(rs('https://ada:p%40ss%3Aw0rd!$@host/x'), 'p%40ss', 'w0rd');
});

test('URLs without credentials and scp-style remotes are untouched', () => {
  for (const s of [
    'https://github.com/org/repo.git',
    'git@github.com:org/repo.git',
    'Pasta Lite <pasta-lite@localhost>',
    'mailto ada@example.com',
    'https://example.com/path?q=1#frag',
  ]) assert.equal(rs(s), s);
});

test('realistic git stderr: fetch / push / clone failures keep their meaning', () => {
  const push = [
    `remote: Invalid username or password.`,
    `fatal: Authentication failed for 'https://ada:${GHP}@github.com/org/repo.git/'`,
  ].join('\n');
  const out = rs(push);
  clean(out, GHP, 'ada:');
  assert.match(out, /^remote: Invalid username or password\.$/m);
  assert.match(out, /fatal: Authentication failed for 'https:\/\/\*\*\*@github\.com\/org\/repo\.git\/'/);

  const access = `fatal: unable to access 'https://x-access-token:${GHO}@github.com/o/r.git/': The requested URL returned error: 403`;
  const a = rs(access);
  clean(a, GHO, 'x-access-token');
  assert.match(a, /The requested URL returned error: 403$/);

  const rejected = [
    `To https://oauth2:${GLPAT_A}@gitlab.com/g/p.git`,
    ' ! [rejected]        main -> main (fetch first)',
    `error: failed to push some refs to 'https://oauth2:${GLPAT_A}@gitlab.com/g/p.git'`,
    'hint: Updates were rejected because the remote contains work that you do not',
  ].join('\n');
  const r = rs(rejected);
  clean(r, 'glpat-aaaa', 'oauth2');
  assert.match(r, / ! \[rejected\] {8}main -> main \(fetch first\)/);
  assert.match(r, /hint: Updates were rejected because the remote contains work that you do not/);

  const trace = `20:01:02.123 http.c:845 => Send header: Authorization: Basic YWRhOnNlY3JldA==\n=> Send header: Authorization: Bearer ${GHP}`;
  const t = rs(trace);
  clean(t, 'YWRhOnNlY3JldA', GHP);
  assert.match(t, /Authorization: Basic \*\*\*/);
  assert.match(t, /Authorization: Bearer \*\*\*/);
});

// ---------------------------------------------------------------- headers, assignments, tokens

test('Authorization / Bearer / token= / password= patterns', () => {
  assert.equal(rs('Authorization: token abcdef123456'), 'Authorization: token ***');
  assert.equal(rs('proxy-authorization=Basic Zm9vOmJhcg=='), 'proxy-authorization=Basic ***');
  assert.equal(rs(`curl -H "Bearer ${JWT}"`), 'curl -H "Bearer ***"');
  assert.equal(rs('https://host/cb?token=abc123&x=1'), 'https://host/cb?token=***&x=1');
  assert.equal(rs('password=hunter2'), 'password=***');
  assert.equal(rs('db_password: "correct horse"'), 'db_password: ***');
  assert.equal(rs("secret='s' and api_key=AK1 and client_secret=zz"), 'secret=*** and api_key=*** and client_secret=***');
  assert.equal(rs('ACCESS-TOKEN=xyz;next'), 'ACCESS-TOKEN=***;next');
});

test('secret names and Bearer values match in any case, with digits, dots, dashes and underscores', () => {
  // The name part: letters of either case, digits, '_', '.' and '-' around the secret word.
  assert.equal(rs('X-Access_Token.v2=abc'), 'X-Access_Token.v2=***');
  assert.equal(rs('my.Api-Key9: "k"'), 'my.Api-Key9: ***');
  assert.equal(rs('Client_SECRET_2=zz'), 'Client_SECRET_2=***');
  // The Bearer value: upper and lower case letters, digits and ._~+/=- (8 or more).
  assert.equal(rs('BEARER AbC.dEf~Gh+i/J=K-9'), 'Bearer ***');
  assert.equal(rs('bearer Ab-1'), 'bearer Ab-1'); // too short to be a token
  // A fine-grained GitHub token body is letters, digits and underscores.
  assert.equal(rs(PAT_SHORT), '***');
});

test('GitHub / GitLab / AWS token shapes anywhere in text', () => {
  const s = rs(`tokens: ${GHP} ${GHO} ${GHU} ${GHS} ${PAT} ${GLPAT} ${AKIA}`);
  clean(s, GHP, GHO, 'ghu_abc', 'ghs_abc', PAT, GLPAT, AKIA);
  // Too short to be a token: a word that merely starts with the prefix.
  assert.equal(rs('ghp_short and glpat-x'), 'ghp_short and glpat-x');
});

test('env style NAME=value for TOKEN / SECRET / PASSWORD / KEY / CREDENTIAL names', () => {
  const awsSecret = 'wJal' + '/K7MDENG';
  const s = rs(`GITHUB_TOKEN=abc AWS_SECRET_ACCESS_KEY=${awsSecret} MY_PASSWORD=pw SSH_KEY=/k GIT_CREDENTIAL=c PATH=/usr/bin HOME=/Users/ada`);
  clean(s, '=abc', 'wJal', '=pw', '=/k', '=c ');
  assert.match(s, /GITHUB_TOKEN=\*\*\* AWS_SECRET_ACCESS_KEY=\*\*\* MY_PASSWORD=\*\*\* SSH_KEY=\*\*\* GIT_CREDENTIAL=\*\*\*/);
  assert.match(s, /PATH=\/usr\/bin HOME=~$/);
});

test('private key blocks, complete or cut off', () => {
  const key = `${pem('BEGIN', 'OPENSSH ')}\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU=\nAAAA+/xyz==\n${pem('END', 'OPENSSH ')}`;
  const s = rs(`before\n${key}\nafter`);
  assert.equal(s, 'before\n[private key redacted]\nafter');
  const rsa = `${pem('BEGIN', 'RSA ')}\nMIIEow==\n${pem('END', 'RSA ')}`;
  assert.equal(rs(rsa), '[private key redacted]');
  const cut = rs(`x ${pem('BEGIN')}\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC`);
  assert.equal(cut, 'x [private key redacted]');
  // A public key is not a secret.
  assert.equal(rs('-----BEGIN PUBLIC KEY-----'), '-----BEGIN PUBLIC KEY-----');
});

// ---------------------------------------------------------------- home, caps, normal text

test('home directory becomes ~, only at a path boundary', () => {
  assert.equal(rs('/Users/ada/projects/app'), '~/projects/app');
  assert.equal(rs("Folder not found: '/Users/ada'"), "Folder not found: '~'");
  assert.equal(rs('at f (/Users/ada/x.js:1:2)'), 'at f (~/x.js:1:2)');
  assert.equal(rs('/Users/adam/projects'), '/Users/adam/projects');
  assert.equal(rs('file:///Users/ada/app/renderer/app.js:3'), 'file://~/app/renderer/app.js:3');
  assert.equal(rs('/users/ADA/x'), '/users/ADA/x', 'case matters off Windows');
});

test('home directory on Windows: any case, either separator, still only at a path boundary', (t) => {
  t.after(() => R._internal.setHome('/Users/ada', { platform: 'darwin' }));
  R._internal.setHome('C:\\Users\\Ada', { platform: 'win32' });
  assert.equal(rs('fatal: C:/users/ada/src/app: not a repo'), 'fatal: ~/src/app: not a repo');
  assert.equal(rs('c:\\USERS\\ada\\x'), '~\\x');
  assert.equal(rs('{"cwd":"C:\\\\users\\\\ADA\\\\x"}'), '{"cwd":"~\\\\x"}', "JSON's doubled '\\'");
  assert.equal(rs('C:\\Users\\Adam\\x'), 'C:\\Users\\Adam\\x');
  // Only ASCII folds, as src/fs-paths.js does: U+212A KELVIN SIGN is 'k' to a regex `i` flag only.
  R._internal.setHome('C:\\Users\\work', { platform: 'win32' });
  assert.equal(rs('C:\\Users\\wor\u212A\\x'), 'C:\\Users\\wor\u212A\\x');
  assert.equal(rs('C:\\USERS\\WORK\\x'), '~\\x');
  R._internal.setHome('/Users/ada', { platform: 'darwin' });
  assert.equal(rs('/Users/ADA/x'), '/Users/ADA/x', 'off Windows the case is kept');
});

test('long strings are capped with a count', () => {
  const s = rs('a'.repeat(R._internal.MAX_STRING + 123));
  assert.equal(s.length, R._internal.MAX_STRING + '…[+123 chars]'.length);
  assert.ok(s.endsWith('…[+123 chars]'));
  // A token past the cap is still redacted first (then cut).
  const t = rs(`${'b'.repeat(R._internal.MAX_STRING - 10)} https://u:${GHP}@h/`);
  clean(t, GHP);
});

test('ordinary text is not over-redacted', () => {
  for (const s of [
    'fatal: not a git repository (or any of the parent directories): .git',
    "error: Your local changes to the following files would be overwritten by checkout:\n\tsrc/key.js",
    'CONFLICT (content): Merge conflict in src/tokenizer.js',
    'Switched to branch \'feature/keyboard\'',
    'hint: Updates were rejected because the tip of your current branch is behind',
    'op failed: push (rejected-behind) after 812 ms',
    'monkey business, keyboard shortcuts, the author said hello',
    'Pushed main to origin/main',
  ]) assert.equal(rs(s), s, s);
});

// ---------------------------------------------------------------- objects and errors

test('nested objects: secret-looking keys masked, content fields omitted, others redacted', () => {
  const out = redact({
    op: 'push',
    repo: '/Users/ada/src/app',
    env: { GITHUB_TOKEN: 'abc', PATH: '/usr/bin', npm_config_password: 'x', AWS_ACCESS_KEY_ID: AKIA },
    headers: { Authorization: 'Bearer abcdefghijk', accept: 'json' },
    nested: [{ deeper: { url: `https://u:${GHP}@github.com/o/r` } }],
    input: 'commit message body',
    stdout: 'diff --git a/x b/x',
    diff: '+secret line',
    patch: '@@ -1 +1 @@',
    content: 'file bytes',
    commitMessage: 'wip: my plans',
    count: 3,
    ok: true,
    nothing: null,
  });
  const s = clean(out, 'abc', AKIA, 'abcdefghijk', GHP, 'commit message body', 'diff --git', '+secret line', 'file bytes', 'my plans');
  assert.equal(out.repo, '~/src/app');
  assert.equal(out.env.GITHUB_TOKEN, '***');
  assert.equal(out.env.npm_config_password, '***');
  assert.equal(out.env.AWS_ACCESS_KEY_ID, '***');
  assert.equal(out.env.PATH, '/usr/bin');
  assert.equal(out.headers.Authorization, '***');
  assert.equal(out.headers.accept, 'json');
  assert.equal(out.nested[0].deeper.url, 'https://***@github.com/o/r');
  for (const k of ['input', 'stdout', 'diff', 'patch', 'content', 'commitMessage']) assert.equal(out[k], '[omitted]', k);
  assert.equal(out.count, 3);
  assert.equal(out.ok, true);
  assert.equal(out.nothing, null);
  assert.ok(!s.includes('Bearer abc'));
});

test('Errors keep name, kind, code, exitCode, redacted message, argv summary and a bounded stack', () => {
  const e = new Error(`fatal: Authentication failed for 'https://ada:${GHP}@github.com/o/r.git/'`);
  e.name = 'GitError';
  e.kind = 'auth';
  e.exitCode = 128;
  e.args = ['-c', 'core.quotePath=false', '-c', 'color.ui=never', 'push', '--porcelain', `https://ada:${GHP}@github.com/o/r.git`, 'main'];
  e.stderr = 'raw stderr must never appear';
  e.stdout = 'raw stdout must never appear';
  e.stack = `GitError: ${e.message}\n${Array.from({ length: 30 }, (_, i) => `    at f${i} (/Users/ada/app/src/x.js:${i}:1)`).join('\n')}`;
  const r = redactError(e);
  clean(r, GHP, 'raw stderr', 'raw stdout', '/Users/ada');
  assert.equal(r.name, 'GitError');
  assert.equal(r.kind, 'auth');
  assert.equal(r.exitCode, 128);
  assert.match(r.message, /^fatal: Authentication failed for 'https:\/\/\*\*\*@github\.com/);
  assert.deepEqual(r.argv, ['push', '--porcelain', 'https://***@github.com/o/r.git', 'main']);
  const lines = r.stack.split('\n');
  assert.equal(lines.length, 13, 'the first 12 lines and a count');
  assert.match(lines[12], /… 19 more/);
  assert.match(lines[1], /at f0 \(~\/app\/src\/x\.js:0:1\)/);
  // Through redact() and inside objects too.
  assert.equal(redact({ err: e }).err.kind, 'auth');
  assert.equal(redact(e).name, 'GitError');
});

test('Error causes, codes and odd values', () => {
  const inner = Object.assign(new Error('EACCES: permission denied, open \'/Users/ada/.config/x\''), { code: 'EACCES' });
  const outer = new Error('could not save', { cause: inner });
  const r = redactError(outer);
  assert.equal(r.cause.code, 'EACCES');
  assert.match(r.cause.message, /'~\/\.config\/x'/);

  const cyc = { a: 1 };
  cyc.self = cyc;
  assert.equal(redact(cyc).self, '[circular]');
  assert.equal(redact(() => 1), '[function]');
  assert.equal(redact(Buffer.from('secret bytes')), '[12 bytes]');
  assert.equal(redact(Symbol('x')), '[symbol]');
  assert.equal(redact(10n), '10');
  assert.equal(redact(NaN), 'NaN');
  assert.deepEqual(redact(new Map([['token', 'x'], ['a', 1]])), { token: '***', a: 1 });
  assert.equal(redact(undefined), undefined);
  // Big arrays and deep nesting are bounded.
  const big = redact(Array.from({ length: 80 }, (_, i) => i));
  assert.equal(big.length, 51);
  assert.equal(big[50], '…[+30 items]');
  let deep = {};
  const top = deep;
  for (let i = 0; i < 20; i++) deep = (deep.d = {});
  assert.ok(JSON.stringify(redact(top)).includes('[…]'));
  // A getter that throws does not throw out of redact.
  const bad = { get x() { throw new Error('nope'); } };
  assert.equal(redact(bad), '[unserializable]');
});

test('an error-like plain object from the renderer ({message, stack}) is treated as an Error', () => {
  const r = redact({ err: { name: 'TypeError', message: `bad https://u:p@h/`, stack: 'TypeError: x\n    at /Users/ada/a.js:1:1' } });
  assert.equal(r.err.name, 'TypeError');
  assert.equal(r.err.message, 'bad https://***@h/');
  assert.match(r.err.stack, /~\/a\.js/);
});

// ---------------------------------------------------------------- git argv

test('summarizeArgs: -c overrides dropped, pathspecs counted, messages hidden', () => {
  const G = ['-c', 'core.quotePath=false', '-c', 'color.ui=never', '-c', 'diff.context=3'];
  assert.deepEqual(summarizeArgs([...G, 'status', '--porcelain=v2', '-z']), ['status', '--porcelain=v2', '-z']);
  assert.deepEqual(summarizeArgs([...G, 'clean', '-f', '-q', '--', 'a.txt', 'secret/plan.md', 'b']), ['clean', '-f', '-q', '--', '<3 paths>']);
  assert.deepEqual(summarizeArgs(['diff', '--cached', '--', 'one.txt']), ['diff', '--cached', '--', '<1 path>']);
  assert.deepEqual(summarizeArgs(['checkout', '-q', '--no-guess', 'main', '--']), ['checkout', '-q', '--no-guess', 'main', '--', '<0 paths>']);
  assert.deepEqual(summarizeArgs(['stash', 'push', '--include-untracked', '-m', 'my secret plan']), ['stash', 'push', '--include-untracked', '-m', '<message>']);
  assert.deepEqual(summarizeArgs(['merge', '--ff', '-m', "Merge branch 'main' of origin", 'refs/remotes/origin/main']),
    ['merge', '--ff', '-m', '<message>', 'refs/remotes/origin/main']);
  assert.deepEqual(summarizeArgs(['commit', '--message=hello world', '-F', '-']), ['commit', '--message=<message>', '-F', '<message>']);
  assert.deepEqual(summarizeArgs(['update-ref', '-m', 'undo: commit x', 'refs/heads/main', 'a', 'b']), ['update-ref', '-m', '<message>', 'refs/heads/main', 'a', 'b']);
  assert.deepEqual(summarizeArgs(['reflog', 'write', 'HEAD', 'aaa', 'aaa', 'undo: commit: my private subject']), ['reflog', 'write', 'HEAD', 'aaa', 'aaa', '<message>']);
  assert.deepEqual(summarizeArgs(['add', '--pathspec-from-file=-', '--pathspec-file-nul']), ['add', '--pathspec-from-file=-', '--pathspec-file-nul']);
  const long = summarizeArgs(['rev-parse', 'x'.repeat(500)]);
  assert.equal(long[1].length, 201);
  assert.deepEqual(summarizeArgs(null), []);
});

test('redactEnv masks every secret-looking name', () => {
  assert.deepEqual(R._internal.redactEnv({ GH_TOKEN: 'x', LANG: 'C', MY_KEY: 'k', HOME: '/Users/ada' }), { GH_TOKEN: '***', LANG: 'C', MY_KEY: '***', HOME: '~' });
});
