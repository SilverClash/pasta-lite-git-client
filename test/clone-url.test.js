'use strict';
// The clone source and folder-name rules (src/clone-url.js): which typed URLs may reach git clone,
// the folder name derived from a source, and the one-segment names main accepts. Pure: no git runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseCloneUrl, deriveName, nameError, MAX_URL } = require('../src/clone-url');

const PLATFORMS = ['win32', 'darwin'];
const ch = (n) => String.fromCharCode(n);
const LOCAL = /^Enter a remote URL \(https:\/\/…, ssh:\/\/…, git@host:…\)/;

test('accepted: https, scp-like, ssh://, git:// and http://, with their kind, host, user and notes', () => {
  const cases = [
    ['https://github.com/o/r.git', { kind: 'https', host: 'github.com', user: null, path: '/o/r.git', notes: [] }],
    ['git@github.com:o/r.git', { kind: 'scp', host: 'github.com', user: 'git', path: 'o/r.git', notes: [] }],
    ['ssh://git@host:2222/o/r', { kind: 'ssh', host: 'host', user: 'git', path: '/o/r', notes: [] }],
    ['git://h/r', { kind: 'git', host: 'h', user: null, path: '/r', notes: ['insecure'] }],
    ['https://bob@bitbucket.org/o/r.git', { kind: 'https', host: 'bitbucket.org', user: 'bob', notes: ['user-in-url'] }],
    ['http://h/r', { kind: 'http', host: 'h', notes: ['insecure'] }],
    ['ssh://alice@[::1]:22/r', { kind: 'ssh', host: '[::1]', user: 'alice', notes: ['user-in-url'] }],
    ['git@[::1]:o/r.git', { kind: 'scp', host: '[::1]', user: 'git', path: 'o/r.git', notes: [] }],
    ['[fe80::1]:r', { kind: 'scp', host: '[fe80::1]', user: null, path: 'r' }],
    ['https://b\u00fccher.example/r', { kind: 'https', host: 'b\u00fccher.example' }],
    ['https://192.168.1.7:65535/r', { kind: 'https', host: '192.168.1.7' }],
    ['ssh://_svc@h/r', { kind: 'ssh', user: '_svc' }],
    ['https://h:8443/', { kind: 'https', host: 'h', path: '/' }],
  ];
  for (const [url, want] of cases) {
    const r = parseCloneUrl(`  ${url}\n`);
    assert.equal(r.ok, true, `${url}: ${r.reason}`);
    assert.equal(r.url, url, 'trimmed, nothing else changed');
    assert.equal(r.display, url);
    for (const [k, v] of Object.entries(want)) assert.deepEqual(r[k], v, `${url} ${k}`);
  }
});

test('refused, on every platform: local sources (paths, file: URLs, UNC, device and drive paths)', () => {
  const local = ['file:///srv/r.git', 'file://host/share/r', 'FILE:///x', 'file:x', '/srv/r.git', '~/r', 'C:\\r\\x.git', 'C:/r/x',
    'C:repo', '\\\\srv\\share\\r.git', '//srv/share/r', '\\\\?\\C:\\r', '\\\\.\\pipe\\x', './r', '../r', '.', 'r.git', 'o/r:x'];
  for (const url of local) {
    // parseCloneUrl takes no platform: the page can't be trusted to name its own.
    const r = parseCloneUrl(url);
    assert.equal(r.ok, false, url);
    assert.match(r.reason, LOCAL, url);
  }
});

test('refused: argument injection, helpers and other schemes', () => {
  const cases = [
    ['-oProxyCommand=x:y', /start with "-"/],
    ['ssh://-x/y', /host name can't start with "-"/],
    ['-x', /start with "-"/],
    ['host:-x', /path can't start with "-"/],
    ['ext::sh -c x', /helper program/],
    ['fd::3', /helper program/],
    ['hg::https://x', /helper program/],
    ['codecommit://r', /aren't supported/],
    ['git+ssh://h/r', /aren't supported/],
    ['ftp://h/r', /aren't supported/],
    ['https:///r', /no host/],
    ['https://h:x/r', /host name isn't valid|port/],
    ['https://h:123456/r', /port/],
    ['host:', /no repository path/],
    ['git@h:r', /too short/],
    ['https://h\\r', /Use "\/" in a URL/],
  ];
  for (const [url, re] of cases) {
    const r = parseCloneUrl(url);
    assert.equal(r.ok, false, url);
    assert.match(r.reason, re, url);
  }
});

test('refused: a password, a token-shaped or unusual user name (https, ssh://, scp-like)', () => {
  const ghp = `ghp_${'a1'.repeat(18)}`;
  const azure = 'a1'.repeat(26); // 52 characters: an Azure DevOps PAT
  const gitea = '0123456789abcdef0123456789abcdef01234567'; // 40 hex
  const cases = [
    ['https://u:p@h/r', /password/],
    ['https://u:@h/r', /password/],
    ['ssh://git:secret@h/r', /password/],
    [`https://${ghp}@github.com/o/r`, /access token/],
    [`https://hf_${'x'.repeat(30)}@h/r`, /access token/],
    [`https://glpat-${'x'.repeat(20)}@gitlab.com/o/r`, /access token/],
    ['https://npm_abc@h/r', /access token/],
    ['https://xoxb-1@h/r', /access token/],
    [`https://${azure}@dev.azure.com/o/p/_git/r`, /access token|user name/],
    [`https://${gitea}@gitea.example/o/r`, /access token/],
    [`${'a1b2c3d4e5f6'.repeat(2)}@h:r`, /access token/],
    ['https://a%40b@h/r', /user name can't be used/],
    ['https://a b@h/r', /user name can't be used|host/],
    [`https://${'u'.repeat(40)}@h/r`, /user name can't be used/],
  ];
  for (const [url, re] of cases) {
    const r = parseCloneUrl(url);
    assert.equal(r.ok, false, url);
    assert.match(r.reason, re, url);
  }
  // Ordinary user names stay, with the note; git@ is the ssh convention and gets none.
  assert.deepEqual(parseCloneUrl('https://alice.smith@h/r').notes, ['user-in-url']);
  assert.deepEqual(parseCloneUrl('ssh://git@h/r').notes, []);
  assert.deepEqual(parseCloneUrl('https://git@h/r').notes, ['user-in-url']);
  assert.equal(parseCloneUrl(`https://${'a'.repeat(30)}@h/r`).ok, true, 'letters only: not token-shaped');
});

test('refused for http(s): a query or a fragment; other schemes keep them as path text', () => {
  for (const url of ['https://h/r?private_token=x', 'https://h/r#x', 'http://h/r?a', 'https://h?x']) {
    const r = parseCloneUrl(url);
    assert.equal(r.ok, false, url);
    assert.match(r.reason, /"\?\u2026" or "#\u2026"/, url);
  }
  assert.equal(parseCloneUrl('git@host:r#x').ok, true);
});

test('refused: empty, too long, control and bidi characters', () => {
  assert.match(parseCloneUrl('').reason, /Enter a repository URL/);
  assert.match(parseCloneUrl('   ').reason, /Enter a repository URL/);
  assert.match(parseCloneUrl(null).reason, /Enter a repository URL/);
  const long = `https://h/${'r'.repeat(MAX_URL)}`;
  assert.match(parseCloneUrl(long.slice(0, MAX_URL + 1)).reason, /longer than 2048/);
  assert.equal(parseCloneUrl(long.slice(0, MAX_URL)).ok, true, '2,048 characters are fine');
  for (const c of [0x00, 0x07, 0x1b, 0x7f, 0x85, 0x202e, 0x2066]) {
    const r = parseCloneUrl(`https://h/r${ch(c)}x`);
    assert.equal(r.ok, false, c.toString(16));
    assert.match(r.reason, /invisible or control/);
  }
});

test('deriveName follows git (git_url_basename): scheme, user, trailing parts, port, .git / .bundle', () => {
  const cases = [
    ['r.git', 'r'], ['https://h/o/r/', 'r'], ['https://h/o/r/.git', 'r'], ['https://h/o/r.git/', 'r'],
    ['host:o/r.git', 'r'], ['git@github.com:o/r.git', 'r'], ['host:r.git', 'r'], ['https://h:8443/', 'h'],
    ['https://user@h:8443', 'h'], ['x.bundle', 'x'], ['https://h/a%20b', 'a%20b'], ['ssh://git@h:22/o/repo.git', 'repo'],
    ['/srv/a/b.git', 'b'], ['/foo/bar:2222.git', '2222'], ['', ''], ['https://h/.git', 'h'],
  ];
  for (const platform of PLATFORMS) {
    for (const [src, want] of cases) assert.equal(deriveName(src, { platform }), want, `${platform} ${src}`);
  }
  assert.equal(deriveName('C:\\a\\b.git', { platform: 'win32' }), 'b', 'a Windows-style path (backslashes separate too)');
  assert.equal(deriveName('\\\\srv\\share\\proj\\', { platform: 'win32' }), 'proj');
});

test('deriveName cleans the name for the platform, and gives up ("") when nothing valid is left', () => {
  assert.equal(deriveName(`https://h/a${ch(0x202e)}b.git`, { platform: 'darwin' }), 'ab', 'invisible characters removed');
  assert.equal(deriveName('git@h:o/a*b"c', { platform: 'win32' }), 'a-b-c');
  assert.equal(deriveName('git@h:o/a*b"c', { platform: 'darwin' }), 'a*b"c', 'valid on macOS');
  assert.equal(deriveName('git@h:o/name. . ', { platform: 'win32' }), 'name');
  assert.equal(deriveName('git@h:o/con', { platform: 'win32' }), '', 'a device name');
  assert.equal(deriveName('git@h:o/con', { platform: 'darwin' }), 'con');
  assert.equal(deriveName('git@h:o/..', { platform: 'darwin' }), '');
  assert.equal(deriveName('https://h/o/.GIT', { platform: 'darwin' }), '');
});

test('nameError: one segment, not . / .., not too long, no .git; on Windows the device and character rules', () => {
  for (const platform of PLATFORMS) {
    const err = (n) => nameError(n, { platform });
    assert.equal(err('repo'), null);
    assert.equal(err('my repo (2)'), null);
    assert.match(err(''), /Enter a folder name/);
    assert.match(err('  '), /Enter a folder name/);
    assert.match(err('.'), /"\." or "\.\."/);
    assert.match(err('..'), /"\." or "\.\."/);
    assert.match(err('a/b'), /can't contain "\/"/);
    assert.match(err('a\\b'), /can't contain "\/"/, '"\\" is refused on POSIX too');
    assert.match(err('.git'), /\.git/);
    assert.match(err('.GIT'), /\.git/);
    assert.match(err(`a${ch(0x0a)}b`), /invisible or control/);
    assert.equal(err('x'.repeat(255)), null);
    assert.match(err('x'.repeat(256)), /too long/);
    assert.match(err('\u00e9'.repeat(128)), /too long/, '256 UTF-8 bytes');
  }
  const win = (n) => nameError(n, { platform: 'win32' });
  const mac = (n) => nameError(n, { platform: 'darwin' });
  for (const n of ['CON', 'nul.txt', 'COM1', 'lpt9']) {
    assert.match(win(n), /reserves for a device/, n);
    assert.equal(mac(n), null, n);
  }
  for (const n of ['x.', 'x ']) {
    assert.match(win(n), /end with a dot or a space/, n);
    assert.equal(mac(n), null, n);
  }
  for (const n of ['a:b', 'a<b', 'a>b', 'a"b', 'a|b', 'a?b', 'a*b']) {
    assert.match(win(n), /can't contain </, n);
    assert.equal(mac(n), null, n);
  }
  assert.match(win('GIT~1'), /\.git/, 'the 8.3 alias');
  assert.equal(mac('GIT~1'), null);
});

test('the UMD file works as a plain browser script after display-text.js and path-names.js', () => {
  const vm = require('node:vm');
  const window = {};
  const ctx = vm.createContext({ window, TextEncoder });
  for (const f of ['display-text.js', 'path-names.js', 'clone-url.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8'), ctx);
  }
  assert.equal(window.PLCloneUrl.parseCloneUrl('git@host:o/r.git').kind, 'scp');
  assert.match(window.PLCloneUrl.parseCloneUrl('C:\\r').reason, LOCAL);
  assert.equal(window.PLCloneUrl.deriveName('https://h/o/r.git', { platform: 'win32' }), 'r');
  assert.match(window.PLCloneUrl.nameError('nul', { platform: 'win32' }), /device/);
});

test('a scheme in any case is accepted with the scheme lowercased: git allows transports by their lower-case names', () => {
  for (const [typed, want] of [['HTTPS://Example.com/r', 'https://Example.com/r'], ['Ssh://git@h/R', 'ssh://git@h/R'], ['GIT://h/r', 'git://h/r'], ['hTTp://h/r', 'http://h/r']]) {
    const r = parseCloneUrl(typed);
    assert.equal(r.ok, true, typed);
    assert.equal(r.url, want, typed);
    assert.equal(r.display, want);
    assert.equal(r.kind, want.split(':')[0]);
  }
});

test('hosts: only names, IPv4 and bracketed IPv6; nothing a shell reads in ssh\'s ProxyCommand %h (CVE-2023-51385)', () => {
  for (const url of ['ssh://x;touch$IFS.pwned;/r', 'git@x;id;:r', 'ssh://h$(id)/r', 'ssh://h`id`/r', 'https://h&x/r', 'git@h|x:r', 'ssh://a!b/r',
    'ssh://h*/r', 'https://h=x/r', 'https://h,x/r', 'https://h~x/r', 'https://h_x/r', 'ssh://-h/r', 'https://h-/r', 'ssh://h./r', 'git@[x;id]:r', 'git@[::1:r']) {
    const r = parseCloneUrl(url);
    assert.equal(r.ok, false, url);
  }
  assert.match(parseCloneUrl('ssh://h$(id)/r').reason, /host name isn't valid/);
});

test('user names never start with "-" (they would reach ssh as an option)', () => {
  for (const url of ['ssh://-oProxyCommand@h/r', 'https://-x@h/r', '-x@host:r', 'ssh://.x@h/r']) {
    const r = parseCloneUrl(url);
    assert.equal(r.ok, false, url);
  }
  assert.match(parseCloneUrl('ssh://-oProxyCommand@h/r').reason, /user name can't be used/);
  assert.equal(parseCloneUrl('ssh://a-b.c_d@h/r').ok, true);
});

test('ports 1 to 65535 only', () => {
  for (const port of ['0', '65536', '99999']) assert.match(parseCloneUrl(`https://h:${port}/r`).reason, /port isn't valid/, port);
  for (const port of ['1', '22', '65535']) assert.equal(parseCloneUrl(`ssh://h:${port}/r`).ok, true, port);
});

test('a scheme with a missing "//" (scp-like, the host a scheme) asks whether "://" was meant', () => {
  for (const [url, scheme] of [['https:/github.com/o/r', 'https'], ['https:github.com/o/r', 'https'], ['SSH:host/r', 'ssh'], ['git:h/r', 'git'], ['user@http:x/r', 'http']]) {
    const r = parseCloneUrl(url);
    assert.equal(r.ok, false, url);
    assert.match(r.reason, new RegExp(`^Did you mean ${scheme}://\u2026\\?`), url);
  }
});

test('zero-width and format characters are refused in a URL and a folder name, and dropped from a derived name', () => {
  const zw = [0x00ad, 0x180e, 0x200b, 0x200c, 0x200d, 0x2060, 0x2064, 0xfeff];
  for (const c of zw) {
    assert.match(parseCloneUrl(`https://git${ch(c)}hub.com/o/r`).reason, /invisible or control/, c.toString(16));
    assert.match(nameError(`r${ch(c)}`, { platform: 'darwin' }), /invisible or control/, c.toString(16));
    assert.equal(deriveName(`https://h/o/a${ch(c)}b.git`, { platform: 'darwin' }), 'ab', c.toString(16));
  }
});
