'use strict';
// Build a demo repository for UI screenshots and manual testing:
//   node scripts/demo-repo.js <dir>
// History: main with feature/fix branches, merges, an octopus merge, tags, a bare "origin"
// with remote branches (local main is one commit ahead of origin/main), stashes, and a dirty working tree
// (staged + unstaged + untracked, incl. a Latin-1 file and a rename).
// Images (the diff view's image preview, docs/plans/image-preview.md §10.4) under images/: a PNG logo
// and an SVG icon changed by a later commit, an animated WebP changed in the working tree, an
// EXIF-rotated JPEG, an animated GIF, an AVIF, a HEIC, a two-page TIFF and a PSD (shown through the OS
// thumbnailer on macOS and Windows, else "preview not supported"), a .png
// holding JPEG bytes, and two Git LFS pointers: lfs-cached.png, whose object is put in the local LFS
// cache (.git/lfs/objects), and lfs-missing.png, whose object isn't. The bytes are the small files in
// test/fixtures/images, made once with ImageMagick 7 (PNG, WebP, GIF, JPEG; the JPEG's EXIF
// orientation 6 added by hand; TIFF, PSD), ffmpeg + SVT-AV1 (AVIF) and macOS sips (HEIC).
// scripts/smoke-image-preview.js checks the image preview on this repository.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const dir = path.resolve(process.argv[2] || 'demo-repo');
const origin = `${dir}.origin.git`; // bare "origin" created next to the repo
if (fs.existsSync(dir) && fs.readdirSync(dir).length) {
  console.error(`${dir} exists and is not empty`);
  process.exit(1);
}
if (fs.existsSync(origin)) {
  console.error(`${origin} already exists`);
  process.exit(1);
}
fs.mkdirSync(dir, { recursive: true });
const env = {
  ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Ada Lovelace', GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_COMMITTER_NAME: 'Ada Lovelace', GIT_COMMITTER_EMAIL: 'ada@example.com',
};
let t = Date.parse('2026-06-01T09:00:00Z') / 1000;
/** git at the current fake time `t`; `extraEnv` overrides (e.g. the author). */
const gitWith = (extraEnv, cwd, ...args) => execFileSync('git', args, {
  cwd, env: { ...env, GIT_AUTHOR_DATE: `${t} +0000`, GIT_COMMITTER_DATE: `${t} +0000`, ...extraEnv }, encoding: 'utf8',
});
const git = (cwd, ...args) => gitWith({}, cwd, ...args);
const authors = [['Ada Lovelace', 'ada@example.com'], ['Grace Hopper', 'grace@example.com'], ['Linus T', 'linus@example.com'], ['Margaret H', 'margaret@example.com']];
let n = 0;
function commit(msg, files, who = n % authors.length) {
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), c);
  }
  git(dir, 'add', '-A');
  t += 3600 + (n % 5) * 900;
  n++;
  const [name, email] = authors[who];
  gitWith({ GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email }, dir, 'commit', '-q', '-m', msg);
}
const lines = (k, len = 30) => Array.from({ length: len }, (_, i) => `line ${i + 1} ${k}`).join('\n') + '\n';
const image = (f) => fs.readFileSync(path.join(__dirname, '..', 'test', 'fixtures', 'images', f));
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
/** A Git LFS pointer file (spec v1) for `bytes`. */
const lfsPointer = (bytes) => `version https://git-lfs.github.com/spec/v1\noid sha256:${sha256(bytes)}\nsize ${bytes.length}\n`;

git(dir, 'init', '-q', '-b', 'main');
commit('chore: initial commit', { 'README.md': '# Demo\n', 'src/app.js': lines('v1') });
commit('feat: add parser', { 'src/parser.js': lines('parser') });
commit('docs: usage section', { 'README.md': '# Demo\n\n## Usage\n\nRun it.\n' });
git(dir, 'tag', '-a', 'v1.0.0', '-m', 'release 1.0.0');
git(dir, 'switch', '-q', '-c', 'feature/graph');
commit('feat(graph): lane layout', { 'src/graph.js': lines('graph') });
commit('feat(graph): colours', { 'src/graph.js': lines('graph2') });
git(dir, 'switch', '-q', 'main');
commit('fix: off-by-one in parser', { 'src/parser.js': lines('parser-fixed') });
git(dir, 'switch', '-q', '-c', 'fix/unicode', 'HEAD~1');
commit('fix: handle ünïcødé paths', { 'src/paths.js': 'export const s = "ünïcødé 🚀";\n' });
git(dir, 'switch', '-q', 'main');
t += 600;
git(dir, 'merge', '-q', '--no-ff', '-m', "Merge branch 'feature/graph'", 'feature/graph');
commit('refactor: split app', { 'src/app.js': lines('v2'), 'src/util.js': lines('util') });
git(dir, 'switch', '-q', '-c', 'feature/a', 'HEAD');
commit('feat: a', { 'a.txt': 'a\n' });
git(dir, 'switch', '-q', '-c', 'feature/b', 'main');
commit('feat: b', { 'b.txt': 'b\n' });
git(dir, 'switch', '-q', 'main');
t += 600;
git(dir, 'merge', '-q', '--no-ff', '-m', 'Merge feature/a, feature/b and fix/unicode', 'feature/a', 'feature/b', 'fix/unicode');
git(dir, 'tag', 'v1.1.0');
for (let i = 0; i < 12; i++) commit(`chore: routine change ${i + 1}\n\nLonger body text explaining change ${i + 1}.`, { 'CHANGELOG.md': lines(`c${i}`, 5 + i) });
commit('feat(images): logo, icons and photos', {
  'images/logo.png': image('logo-v1.png'),
  'images/icon.svg': image('icon-v1.svg'),
  'images/hero.webp': image('hero-v1.webp'),
  'images/photo.jpg': image('photo.jpg'),
  'images/sprite.gif': image('sprite.gif'),
  'images/badge.avif': image('badge.avif'),
  'images/scan.heic': image('scan.heic'),
  'images/scan.tiff': image('scan.tiff'),
  'images/layers.psd': image('layers.psd'),
  'images/mislabeled.png': image('mislabeled.png'),
  'images/lfs-cached.png': lfsPointer(image('logo-v2.png')),
  'images/lfs-missing.png': lfsPointer(image('hero-v2.webp')),
});
commit('feat(images): new logo and icon', { 'images/logo.png': image('logo-v2.png'), 'images/icon.svg': image('icon-v2.svg') });
git(dir, 'switch', '-q', '-c', 'feature/long-running', 'HEAD~6');
commit('wip: experiment', { 'exp.txt': 'x\n' });
git(dir, 'switch', '-q', 'main');

// Remote: bare origin; local main gets one more commit afterwards, so it is 1 ahead of origin/main.
execFileSync('git', ['init', '-q', '--bare', origin], { env });
git(dir, 'remote', 'add', 'origin', origin);
git(dir, 'push', '-q', 'origin', 'main', 'feature/graph', 'fix/unicode', '--tags');
git(dir, 'branch', '-q', '--set-upstream-to=origin/main', 'main');
commit('feat: local-only change (ahead)', { 'local.txt': 'ahead\n' });

// Stashes
fs.writeFileSync(path.join(dir, 'README.md'), '# Demo\n\nstash me\n');
git(dir, 'stash', 'push', '-q', '-m', 'half-done readme');
fs.writeFileSync(path.join(dir, 'src/app.js'), lines('stashed'));
git(dir, 'stash', 'push', '-q', '-m', 'app experiment');

// Dirty working tree
fs.writeFileSync(path.join(dir, 'src/app.js'), lines('v2').replace('line 3 v2', 'line 3 CHANGED').replace('line 27 v2', 'line 27 CHANGED'));
fs.writeFileSync(path.join(dir, 'src/util.js'), lines('util').replace('line 10 util', 'line 10 staged'));
git(dir, 'add', 'src/util.js');
git(dir, 'mv', 'b.txt', 'renamed-b.txt');
fs.writeFileSync(path.join(dir, 'latin1.txt'), Buffer.from('caf\xe9 cr\xe8me\n', 'latin1'));
fs.mkdirSync(path.join(dir, 'notes'), { recursive: true });
fs.writeFileSync(path.join(dir, 'notes', 'new file.md'), '# New\n\nuntracked\n');
fs.writeFileSync(path.join(dir, 'images', 'hero.webp'), image('hero-v2.webp'));

// The local Git LFS cache: lfs-cached.png's object (lfs-missing.png's is never downloaded).
const cached = image('logo-v2.png');
const oid = sha256(cached);
const objects = path.join(dir, '.git', 'lfs', 'objects', oid.slice(0, 2), oid.slice(2, 4));
fs.mkdirSync(objects, { recursive: true });
fs.writeFileSync(path.join(objects, oid), cached);
console.log(dir);
