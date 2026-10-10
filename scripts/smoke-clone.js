'use strict';
// Check Clone Repository… in the real app (docs/plans/clone-repository.md C5):
//   node scripts/smoke-clone.js [out.png]
// Builds a small repository and a slow one (a smudge filter from its own git config makes the
// checkout last seconds) in a temporary folder, serves them over a smart-HTTP server on 127.0.0.1
// (git http-backend behind Node's http: the app's own URL rules and transport allowlist apply, as
// for any remote), and runs the --smoke harness (main/smoke.js) on a New Tab with the page script
// scripts/smoke/clone.page.js: a clone into a folder that exists (refused, nothing touched), a clone
// typed as http://127.0.0.1:<port>/small.git that opens in the tab, and a clone cancelled during its
// checkout (no folder left). The parent folder comes from PL_SMOKE_CLONE_PARENT (what main's folder
// dialog answers in a smoke run); nothing leaves the machine (the manual QA covers real remotes,
// docs/plans §11.3). Prints what failed and exits 0 when every check passed. With out.png the first run's window is captured
// there; without it nothing is captured (PL_SMOKE_QUIT). Needs the dev dependencies.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, execFile, spawn } = require('node:child_process');

const root = path.join(__dirname, '..');
const out = process.argv[2] ? path.resolve(process.argv[2]) : null;
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pl-clone-smoke-')));
const isolated = path.join(tmp, 'gitconfig'); // the clone's git reads this, never ~/.gitconfig
const env = {
  ...process.env, GIT_CONFIG_GLOBAL: isolated, GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Ada Lovelace', GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_COMMITTER_NAME: 'Ada Lovelace', GIT_COMMITTER_EMAIL: 'ada@example.com',
};
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });

/** A bare repository at `bare` from `files` (name -> text) committed in a seed next to it. */
function bareRepo(bare, files) {
  const seed = `${bare}.seed`;
  fs.mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'main');
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(seed, name), text);
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'files');
  git(tmp, 'clone', '-q', '--bare', seed, bare);
  return bare;
}

/**
 * A smart-HTTP server for the bare repositories under `dir`: Node's http in front of git
 * http-backend (CGI), on 127.0.0.1 and a port the OS picks. Resolves {url(name), close()}.
 */
async function gitHttpServer(dir) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const cgi = spawn('git', ['http-backend'], {
      env: {
        ...env, GIT_PROJECT_ROOT: dir, GIT_HTTP_EXPORT_ALL: '1', REMOTE_ADDR: '127.0.0.1',
        REQUEST_METHOD: req.method, PATH_INFO: decodeURIComponent(u.pathname), QUERY_STRING: u.search.slice(1),
        CONTENT_TYPE: req.headers['content-type'] || '', CONTENT_LENGTH: req.headers['content-length'] || '',
        HTTP_CONTENT_ENCODING: req.headers['content-encoding'] || '', GIT_PROTOCOL: req.headers['git-protocol'] || '',
      },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    req.pipe(cgi.stdin);
    let head = Buffer.alloc(0);
    let sent = false;
    cgi.stdout.on('data', (d) => {
      if (sent) { res.write(d); return; }
      head = Buffer.concat([head, d]);
      const m = /\r?\n\r?\n/.exec(head.toString('latin1'));
      if (!m) return;
      let status = 200;
      const headers = {};
      for (const line of head.subarray(0, m.index).toString('latin1').split(/\r?\n/)) {
        const h = /^([^:]+):\s*(.*)$/.exec(line);
        if (h && h[1].toLowerCase() === 'status') status = parseInt(h[2], 10);
        else if (h) headers[h[1]] = h[2];
      }
      res.writeHead(status, headers);
      sent = true;
      const rest = head.subarray(m.index + m[0].length);
      if (rest.length) res.write(rest);
    });
    cgi.on('close', () => { if (!sent) res.writeHead(500); res.end(); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: (name) => `http://127.0.0.1:${server.address().port}/${name}`,
    close: () => { server.closeAllConnections(); server.close(); },
  };
}

/** One --smoke run of the page script with `plan` and `url`; the script's {ok, failures, steps}, or the harness's error. */
async function smoke({ plan, url, parent, config, png }) {
  const electron = require('electron'); // the binary's path under Node
  const page = path.join(tmp, `page-${plan.replace(/\W/g, '-')}.js`);
  const set = `window.PL_SMOKE_PLAN = ${JSON.stringify(plan)};\nwindow.PL_SMOKE_URL = ${JSON.stringify(url)};\n`;
  fs.writeFileSync(page, `${set}${fs.readFileSync(path.join(__dirname, 'smoke', 'clone.page.js'), 'utf8')}`);
  fs.writeFileSync(isolated, config);
  const runEnv = { ...env, PL_SMOKE_JS: page, PL_SMOKE_CLONE_PARENT: parent };
  if (!png) runEnv.PL_SMOKE_QUIT = '1';
  delete runEnv.PL_SMOKE_USERDATA; // always a throwaway userData: never a folder another instance uses
  // Not execFileSync: this process serves the clone over HTTP meanwhile.
  const text = await new Promise((resolve) => {
    execFile(electron, ['.', '--smoke', png || path.join(tmp, 'unused.png')], { cwd: root, env: runEnv, encoding: 'utf8' }, (e, stdout) => resolve(String(stdout || '')));
  });
  const line = text.split('\n').find((l) => l.startsWith('{'));
  if (!line) return { ok: false, failures: ['no result from the --smoke run'] };
  const res = JSON.parse(line);
  if (!res.script) return { ok: false, failures: [res.error || 'the page script did not run'] };
  return res.script;
}

async function main() {
  let ok = false;
  let server = null;
  try {
    const parent = path.join(tmp, 'parent');
    fs.mkdirSync(parent);
    fs.mkdirSync(path.join(parent, 'exists'));
    fs.writeFileSync(path.join(parent, 'exists', 'keep.txt'), 'mine\n');
    const small = bareRepo(path.join(tmp, 'small.git'), { 'README.md': '# small\n', 'a.txt': 'a\n' });
    const many = {};
    for (let i = 0; i < 300; i++) many[`f${i}.txt`] = `${i}\n`;
    const slow = bareRepo(path.join(tmp, 'slow.git'), { '.gitattributes': '*.txt filter=slow\n', ...many });

    server = await gitHttpServer(tmp);
    const results = {
      'exists, then success': await smoke({ plan: 'exists,success', url: server.url(path.basename(small)), parent, config: '', png: out }),
      cancel: await smoke({ plan: 'cancel', url: server.url(path.basename(slow)), parent, config: '[filter "slow"]\n\tsmudge = "sleep 0.03; cat"\n', png: null }),
    };
    // What the runs left on disk: the folder that existed untouched, the clone, no cancelled folder.
    const disk = [];
    if (fs.readFileSync(path.join(parent, 'exists', 'keep.txt'), 'utf8') !== 'mine\n' || fs.readdirSync(path.join(parent, 'exists')).length !== 1) disk.push('the existing folder was touched');
    if (!fs.existsSync(path.join(parent, 'small', '.git')) || !fs.existsSync(path.join(parent, 'small', 'README.md'))) disk.push('the clone is not in the parent folder');
    if (fs.existsSync(path.join(parent, 'cancelled'))) disk.push('the cancelled clone left its folder');
    results.disk = { ok: !disk.length, failures: disk };
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
    if (server) server.close();
    fs.rmSync(tmp, { recursive: true, force: true }); // also when building a repository failed
  }
  return ok;
}

main().then((ok) => process.exit(ok ? 0 : 1));
