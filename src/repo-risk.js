'use strict';
// What in a repository can make git run a program, for the Trust and Open prompt
// (src/repo-trust.js): keys of the repo's own config (riskyLocalConfig), the hooks git would run
// (riskyHooks), and the same for the other git dirs git may work in for this repository
// (riskyNested): its submodules' and its other worktrees'. Nothing here runs a configured
// program: config is read with `git config`, hooks are listed from the file system. git.js
// re-exports it all.
const fs = require('node:fs');
const path = require('node:path');
const { out, GitError, repoDirs, resolveRoot } = require('./exec');
const { gitAt, tryGitAt } = require('./git-process');
const { parseStageEntries } = require('./porcelain');

// Repo config (local or worktree scope, includes followed) that makes git run a command during
// normal use: filter drivers on `status`/`add`/`checkout`, ssh / credential / proxy programs on
// fetch and push, hooks from another folder, signing programs (and gpg.ssh.defaultKeyCommand, run
// to find the signing key), merge drivers, core.alternateRefsCommand (fetch/push with
// alternates). core.fsmonitor and protocol.ext.allow are not listed: git-process.js always
// overrides them. Matched against git's canonical key (section and name lower-cased, subsection
// as written).
// Programs the app never runs but a terminal git in the same repo would, on everyday commands:
// core.editor / sequence.editor (the app overrides them with GIT_EDITOR / GIT_SEQUENCE_EDITOR,
// git-process.js, src/rebase.js), the pager (core.pager, pager.<cmd>: the app's git has no tty),
// external diff and textconv drivers (the app passes --no-ext-diff --no-textconv), merge/diff
// tools, and trailer commands (`commit --trailer`).
// Not listed: uploadpack.packObjectsHook (git only reads it from global/system config),
// url.*.insteadOf (can only reach ext::, forbidden), remote.*.vcs and alias.* (run installed
// helpers, or only when the user types the repo's own alias name), and mail/browser programs
// (sendemail.*, imap.tunnel, browser.*: only on explicit send-email / help --web).
// Includes (include.path, includeIf.<condition>.path) are listed whatever they point at: the
// check sees an included file only as it is now and only when its condition holds now, but
// `onbranch:` holds once a branch is checked out, and a relative path can point into the working
// tree, which a checkout or a merge rewrites.
const RISKY_CONFIG = '^(filter\\..+\\.(clean|smudge|process)'
  + '|core\\.(sshcommand|hookspath|gitproxy|askpass|editor|pager|alternaterefscommand)|pager\\..+'
  + '|sequence\\.editor|credential\\.(.+\\.)?helper|gpg\\.(.+\\.)?program|gpg\\.ssh\\.defaultkeycommand'
  + '|merge\\..+\\.driver|remote\\..+\\.(uploadpack|receivepack)'
  + '|diff\\.external|diff\\..+\\.(command|textconv)|(merge|diff)tool\\..+\\.(cmd|path)|trailer\\..+\\.(cmd|command)'
  + '|include\\.path|includeif\\..+\\.path)$';

// Keys that only run a command with some values: [key regexp, value regexp]. protocol.allow /
// protocol.<name>.allow = always (any case) re-enables ext:: (and file:// for submodules) for a
// terminal git; submodule.<name>.update = !<command> runs it on `git submodule update`.
const RISKY_VALUES = [
  ['^protocol\\.(.+\\.)?allow$', '^[Aa][Ll][Ww][Aa][Yy][Ss]$'],
  ['^submodule\\..+\\.update$', '^!'],
];

const CONFIG_QUERY = ['config', '--includes', '--show-scope', '-z', '--name-only', '--get-regexp'];

/** The risky keys (local and worktree scope) of the config `git(args, opts)` (resolving to stdout) reads. */
async function riskyKeys(git) {
  const query = (args) => git([...CONFIG_QUERY, ...args], { okCodes: [0, 1] });
  const raws = await Promise.all([query([RISKY_CONFIG]), ...RISKY_VALUES.map((pair) => query(pair))]);
  const keys = new Set();
  for (const raw of raws) {
    const f = raw.split('\0');
    for (let i = 0; i + 1 < f.length; i += 2) {
      if (f[i] === 'local' || f[i] === 'worktree') keys.add(f[i + 1]);
    }
  }
  return [...keys].sort(); // NOSONAR(S2871): config keys are ASCII; code-unit order is the intended, stable order
}

/** The hooks ('hooks/<name>', sorted) in the hooks folder of the git dir `git(args)` runs in. */
async function hooksOf(git) {
  const dir = (await git(['rev-parse', '--path-format=absolute', '--git-path', 'hooks'])).replace(/\n$/, '');
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // no hooks folder
  }
  const runs = (file) => {
    const st = fs.statSync(file, { throwIfNoEntry: false }); // a symlink counts as what it points at
    return !!st && st.isFile() && (process.platform === 'win32' || (st.mode & 0o111) !== 0);
  };
  return entries
    .filter((e) => !e.name.startsWith('.') && !e.name.endsWith('.sample') && runs(path.join(dir, e.name)))
    .map((e) => `hooks/${e.name}`)
    .sort();
}

/** `git(args, opts)` at the worktree root containing `cwd` (exec.out), resolving to stdout. */
const atRepo = (cwd) => (args, opts) => out(cwd, args, opts);

/**
 * Keys of the repo's own config (not global/system/-c) that can run a command, sorted and
 * de-duplicated; [] when there are none. A repo from elsewhere (downloaded, unpacked) should only
 * be opened after the user has agreed to these. Values are matched by git, never read here (a
 * credential helper line can hold a token).
 */
const riskyLocalConfig = (cwd) => riskyKeys(atRepo(cwd));

/**
 * The hooks git would run in the repository ('hooks/<name>', sorted; [] when none): the
 * executable files of its hooks folder (`rev-parse --git-path hooks`, so core.hooksPath is
 * followed, and a linked worktree's are the main repo's), except git's `*.sample` files and
 * dot-files. A clone's .git/hooks holds only samples, but a folder from elsewhere can carry
 * hooks: a downloaded or unzipped working tree its .git/hooks (run on commit, checkout, merge),
 * a bare repo a project tracks its hooks folder (a checked-out file keeps its executable bit;
 * run on the first fetch). main asks before opening either. On Windows git runs a hook
 * whatever its mode, so every file counts.
 */
const riskyHooks = (cwd) => hooksOf(atRepo(cwd));

// ---------------------------------------------------------------- submodules and other worktrees

/** How deep riskyNested follows submodules inside submodules (and folders inside modules/). */
const MAX_DEPTH = 8;
/** How many submodule git dirs riskyNested reads; beyond, it reports that it stopped. */
const MAX_SUBMODULES = 200;

/** True when `dir` looks like a git dir (HEAD, and objects/ or a commondir file), as git checks one. */
function isGitDir(dir) {
  const has = (name, dirWanted) => {
    const st = fs.statSync(path.join(dir, name), { throwIfNoEntry: false });
    return !!st && (dirWanted ? st.isDirectory() : st.isFile());
  };
  return has('HEAD', false) && (has('objects', true) || has('commondir', false));
}

/** The folders directly in `dir` (symlinks to folders included); [] when it can't be read. */
function subdirs(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries.map((name) => path.join(dir, name)).filter((p) => fs.statSync(p, { throwIfNoEntry: false })?.isDirectory());
}

/** realpath of `p`, or p itself when that fails. */
function real(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * The submodule git dirs under `base` (a modules/ folder): a submodule named 'a/b' lives in
 * modules/a/b, and a submodule's own submodules in its modules/. Appends [git dir] to `acc`.
 */
function moduleGitDirs(base, depth, acc) {
  if (depth > MAX_DEPTH) return acc;
  for (const d of subdirs(base)) {
    if (isGitDir(d)) {
      acc.push(d);
      moduleGitDirs(path.join(d, 'modules'), depth + 1, acc);
    } else {
      moduleGitDirs(d, depth + 1, acc);
    }
  }
  return acc;
}

/** Gitlink (submodule) paths of the index `git(args)` reads; [] when it can't (a bare repo). */
async function gitlinks(git) {
  const raw = await git(['ls-files', '-s', '-z']).catch((e) => {
    if (e instanceof GitError && !e.kind) return '';
    throw e;
  });
  return parseStageEntries(raw).filter((e) => e.mode === '160000' && e.stage === 0).map((e) => e.path);
}

/** `git(args, opts)` in the folder `dir` (no root lookup), resolving to stdout; `pre` goes first (--git-dir). */
const atDir = (dir, pre = []) => (args, opts) => gitAt(dir, [...pre, ...args], opts).then((r) => r.stdout);

/**
 * The populated submodules of the worktree `top` (and theirs, to MAX_DEPTH): [{label, git, gd}],
 * `git` running in the submodule's folder as a git that works inside it does (it finds the
 * submodule's git dir through its .git file or folder). A gitlink whose folder git doesn't see as
 * its own repository (no .git, or a broken one: git would then find the superproject) is not
 * populated, and git doesn't look inside it either. `rel`: `top` relative to the tab's root.
 */
async function populated(top, rel, depth, git, acc) {
  if (depth > MAX_DEPTH) return acc;
  for (const p of await gitlinks(git)) {
    const dir = path.join(top, p);
    if (!fs.lstatSync(path.join(dir, '.git'), { throwIfNoEntry: false })) continue;
    const found = await tryGitAt(dir, ['rev-parse', '--show-toplevel', '--absolute-git-dir']);
    if (found === null) continue;
    const [toplevel, gd] = found.split('\n');
    if (!toplevel || !gd || real(toplevel) !== real(dir)) continue;
    const label = rel ? `${rel}/${p}` : p;
    const sub = atDir(dir);
    acc.push({ label, git: sub, gd: real(gd) });
    await populated(dir, label, depth + 1, sub, acc);
  }
  return acc;
}

/** The risky config keys and hooks of one submodule git dir (`git` runs there), or a note that git could not read them. */
async function submoduleRisks(git) {
  try {
    const [config, hooks] = await Promise.all([riskyKeys(git), hooksOf(git)]);
    return [...config, ...hooks];
  } catch (e) {
    if (e instanceof GitError && !e.kind) return ['(its config could not be read)'];
    throw e;
  }
}

/**
 * What can run a program in the other git dirs git may work in for the repository at `cwd`, as
 * '<where>: <key>' strings (sorted; [] when nothing): 'submodule <where>: ...' for each submodule
 * (its config keys and hooks, as riskyLocalConfig and riskyHooks list them) and
 * 'worktree <where>: <key>' for each other worktree (the risky keys git reads there that the
 * repo's own config check doesn't list).
 * - Submodules: a populated one in this worktree (and its own, to MAX_DEPTH) is read the way a git
 *   working inside it does, from its folder; `<where>` is its path. `add -A`, `stash push` and
 *   an autostash look inside it with no flag to stop them, and a terminal's `git submodule`
 *   commands run its hooks. Every other submodule git dir in modules/ of the common dir or of a
 *   linked worktree's admin folder is read too (`<where>`: that folder, relative to the common
 *   dir), since a checkout can populate it. At most MAX_SUBMODULES are read; beyond, an entry
 *   says so (the prompt then asks anyway).
 * - Worktrees: git reads common config there too, plus that worktree's config.worktree and the
 *   includeIf sections that hold only there; `git worktree remove` runs `status` in the removed
 *   worktree, with that config. `<where>`: its admin folder relative to the common dir
 *   ('worktrees/<id>'), or '(main)' for the main worktree when `cwd` is a linked one.
 */
async function riskyNested(cwd) {
  const [{ gitDir, commonDir }, root, own] = await Promise.all([repoDirs(cwd), resolveRoot(cwd), riskyLocalConfig(cwd)]);
  const ownGd = real(gitDir);
  const common = real(commonDir);
  const found = [];
  const relOf = (p) => path.relative(common, p).split(path.sep).join('/');

  const admins = subdirs(path.join(common, 'worktrees')).map(real).filter(isGitDir);
  const worktrees = [common, ...admins].filter((gd) => gd !== ownGd);
  await Promise.all(worktrees.map(async (gd) => {
    const keys = await riskyKeys(atDir(gd, [`--git-dir=${gd}`])).catch((e) => {
      if (e instanceof GitError && !e.kind) return [];
      throw e;
    });
    const where = gd === common ? '(main)' : relOf(gd);
    for (const k of keys) if (!own.includes(k)) found.push(`worktree ${where}: ${k}`);
  }));

  const subs = await populated(root, '', 0, atRepo(cwd), []);
  const seen = new Set([ownGd, ...subs.map((s) => s.gd)]);
  for (const base of [common, ...admins]) {
    for (const gd of moduleGitDirs(path.join(base, 'modules'), 0, []).map(real)) {
      if (seen.has(gd)) continue;
      seen.add(gd);
      subs.push({ label: relOf(gd), git: atDir(gd, [`--git-dir=${gd}`]), gd });
    }
  }
  if (subs.length > MAX_SUBMODULES) found.push(`submodule (more than ${MAX_SUBMODULES}): not all were checked`);
  const checked = subs.slice(0, MAX_SUBMODULES);
  let next = 0;
  const worker = async () => {
    while (next < checked.length) {
      const s = checked[next++];
      for (const k of await submoduleRisks(s.git)) found.push(`submodule ${s.label}: ${k}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, checked.length) }, worker));
  return found.sort(); // NOSONAR(S2871): code-unit order is the intended, stable order
}

module.exports = { RISKY_CONFIG, RISKY_VALUES, riskyLocalConfig, riskyHooks, riskyNested };
