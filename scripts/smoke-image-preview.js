'use strict';
// Check the diff view's image preview in the real app (docs/plans/image-preview.md §10.4):
//   node scripts/smoke-image-preview.js [out.png]
// Builds the demo repository (scripts/demo-repo.js) and a small repository stopped in a merge with a
// conflicted PNG, in a temporary folder, runs the --smoke harness (main/smoke.js) on each with the
// page script scripts/smoke/image-preview.page.js, prints what failed, and exits 0 when every check
// passed. With out.png the demo run's window is captured there (the commit's logo, Before / After:
// the PR screenshot); without it nothing is captured (PL_SMOKE_QUIT). Needs the dev dependencies.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const out = process.argv[2] ? path.resolve(process.argv[2]) : null;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-image-smoke-'));
const env = {
  ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Ada Lovelace', GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_COMMITTER_NAME: 'Ada Lovelace', GIT_COMMITTER_EMAIL: 'ada@example.com',
};
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
const image = (f) => fs.readFileSync(path.join(root, 'test', 'fixtures', 'images', f));

/** A repository whose merge of `other` stopped on images/logo.png: base, ours (a JPEG in a .png) and theirs differ. */
function conflictRepo(dir) {
  const write = (bytes) => {
    fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'images', 'logo.png'), bytes);
  };
  fs.mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  write(image('logo-v1.png'));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'logo');
  git(dir, 'switch', '-q', '-c', 'other');
  write(image('logo-v2.png'));
  git(dir, 'commit', '-q', '-am', 'new logo');
  git(dir, 'switch', '-q', 'main');
  write(image('mislabeled.png'));
  git(dir, 'commit', '-q', '-am', 'another logo');
  try {
    git(dir, 'merge', '-q', 'other');
  } catch {
    return dir; // the conflict
  }
  throw new Error('the merge did not conflict');
}

/** One --smoke run of the page script on `repo`: the script's {ok, failures, steps}, or the harness's error. */
function smoke(repo, png) {
  const electron = require('electron'); // the binary's path under Node
  const runEnv = { ...process.env, PL_SMOKE_JS: path.join(__dirname, 'smoke', 'image-preview.page.js'), PL_SMOKE_SIZE: '1400x900' };
  if (!png) runEnv.PL_SMOKE_QUIT = '1';
  let text;
  try {
    text = execFileSync(electron, ['.', '--smoke', repo, png || path.join(tmp, 'unused.png')], { cwd: root, env: runEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    text = String(e.stdout || '');
  }
  const line = text.split('\n').find((l) => l.startsWith('{'));
  if (!line) return { ok: false, failures: ['no result from the --smoke run'] };
  const res = JSON.parse(line);
  if (!res.script) return { ok: false, failures: [res.error || 'the page script did not run'] };
  return res.script;
}

let ok = false;
try {
  const demo = path.join(tmp, 'demo');
  execFileSync(process.execPath, [path.join(__dirname, 'demo-repo.js'), demo], { stdio: 'ignore' });
  const results = { demo: smoke(demo, out), conflict: smoke(conflictRepo(path.join(tmp, 'conflict')), null) };
  ok = true;
  for (const [name, r] of Object.entries(results)) {
    ok = ok && r.ok;
    console.log(`${r.ok ? 'ok' : 'FAILED'}  ${name}${r.failures.length ? `\n  - ${r.failures.join('\n  - ')}` : ''}`);
  }
  if (process.env.PL_SMOKE_VERBOSE === '1') console.log(JSON.stringify(results, null, 1));
  if (out) console.log(`capture: ${out}`);
} catch (err) {
  console.error(`FAILED  ${err && err.stack ? err.stack : err}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true }); // also when building a repository failed
}
process.exit(ok ? 0 : 1);
