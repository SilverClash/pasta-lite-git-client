'use strict';
// Reading the state of a rebase in progress (docs/plans/rebase.md §3.4) and our state folder
// <git-dir>/pasta-lite/rebase/ (see src/rebase.js for what it holds). Split out of rebase.js:
// git.status reads through here, and nothing here runs a command that changes the repo.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { tryOut, kindError } = require('./exec');
const { readSmall, readJson, exists, isRealDir, stripComments } = require('./gitfiles');
// OURS_MARKER: the file inside rebase-merge/ naming the meta.json id of the rebase we started.
const { PL_DIR, REBASE_DIR, OURS_MARKER } = require('./namespace');
const { OID, branchOf } = require('./gitref');

const MAX_LINES = 10000;

// Todo / done commands: git's abbreviations (an external rebase with rebase.abbreviateCommands).
const ABBREV = Object.freeze({
  p: 'pick', r: 'reword', e: 'edit', s: 'squash', f: 'fixup', d: 'drop', x: 'exec', b: 'break', l: 'label', t: 'reset', m: 'merge', u: 'update-ref',
});
const COMMIT_CMDS = new Set(['pick', 'reword', 'edit', 'squash', 'fixup', 'merge']);
/** Todo commands we never write: a rebase whose remaining todo has one can't be edited by us. */
const FOREIGN_CMDS = new Set(['exec', 'break', 'label', 'reset', 'merge']);
/**
 * A todo line git runs as a shell command: `exec` / `x` (after optional blanks, then a blank or
 * the end of the line, as git parses it). Matched over the whole file, with no line cap.
 */
const EXEC_LINE = /^[ \t]*(?:exec|x)(?:[ \t\r]|$)/m;

const oid = (s) => {
  const t = typeof s === 'string' ? s.trim() : '';
  return OID.test(t) ? t : null;
};

const int = (s) => {
  const t = typeof s === 'string' ? s.trim() : '';
  return /^\d{1,9}$/.test(t) ? Number(t) : null;
};

/** Todo / done lines as [{cmd, sha}] (comments and blank lines skipped; at most MAX_LINES). */
function todoLines(text) {
  if (!text) return [];
  const res = [];
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    if (!l || l.startsWith('#')) continue;
    if (res.length >= MAX_LINES) break;
    const words = l.split(/\s+/);
    const cmd = ABBREV[words[0]] || words[0];
    // "fixup -C <sha>" / "merge -C <sha> <label>": the sha follows the option.
    const arg = words[1] && words[1].startsWith('-') ? words[2] : words[1];
    res.push({ cmd, sha: oid(arg) });
  }
  return res;
}

// ---------------------------------------------------------------- the state folder

const plDir = (gd) => path.join(gd, PL_DIR);
const stateDirOf = (gd) => path.join(plDir(gd), REBASE_DIR);

const notPlain = () => kindError('symlink', 'The rebase state folder inside the git folder is not a plain folder (a symlink?); nothing was changed');

/** Create `dirs` in order as plain folders (0700); kind 'symlink' when something else is there. */
function ensureDirs(dirs) {
  for (const d of dirs) {
    try {
      fs.mkdirSync(d, { mode: 0o700 });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    if (!isRealDir(d)) throw notPlain();
  }
  return dirs[dirs.length - 1];
}

/** <git-dir>/pasta-lite as a plain folder. */
const ensurePlDir = (gd) => ensureDirs([plDir(gd)]);

/** Create <git-dir>/pasta-lite/rebase/msgs as plain folders; returns the state folder. */
function ensureStateDir(gd) {
  const sd = stateDirOf(gd);
  ensureDirs([plDir(gd), sd, path.join(sd, 'msgs')]);
  return sd;
}

/** True when the state folder (and the folder above it) are plain folders. */
const safeState = (gd) => isRealDir(plDir(gd)) && isRealDir(stateDirOf(gd));

/**
 * Write `content` to `<dir>/<name>` with exclusive creation (0600). An existing regular file is
 * replaced (unlinked first); a symlink or anything else in the way is refused (kind 'symlink').
 */
function writeStateFile(dir, name, content) {
  const p = path.join(dir, name);
  const st = fs.lstatSync(p, { throwIfNoEntry: false });
  if (st) {
    if (!st.isFile()) throw notPlain();
    fs.unlinkSync(p);
  }
  const fd = fs.openSync(p, 'wx', 0o600);
  try {
    fs.writeSync(fd, content);
  } finally {
    fs.closeSync(fd);
  }
}

/** Remove the regular file `<dir>/<name>` if it is there (never through a symlinked folder). */
function removeFileIn(dir, name) {
  if (!isRealDir(dir)) return;
  const p = path.join(dir, name);
  const st = fs.lstatSync(p, { throwIfNoEntry: false });
  if (st && st.isFile()) fs.rmSync(p, { force: true });
}

/** Remove the state folder (never through a symlinked <git-dir>/pasta-lite). */
function clearState(gd) {
  if (!isRealDir(plDir(gd))) return;
  fs.rmSync(stateDirOf(gd), { recursive: true, force: true });
}

const removeStateFile = (gd, name) => {
  if (isRealDir(plDir(gd))) removeFileIn(stateDirOf(gd), name);
};

/** A prepared message for commit `sha` (msgs/<sha>), or null. */
function preparedMessage(gd, sha) {
  const msgs = path.join(stateDirOf(gd), 'msgs');
  return safeState(gd) && isRealDir(msgs) && sha ? readSmall(path.join(msgs, sha)) : null;
}

/** True when msgs/ holds a prepared message (Continue / Skip then run with the helper as GIT_EDITOR). */
function hasMessages(gd) {
  const d = path.join(stateDirOf(gd), 'msgs');
  return safeState(gd) && isRealDir(d) && fs.readdirSync(d).length > 0;
}

/**
 * Record the pre-rebase facts of a rebase we start (meta.json), from a fresh state folder. Adds
 * `version`, a random `id` and `starting: true` (see markOurs). Never holds commit messages
 * (they go to msgs/ only).
 */
function writeMeta(gd, meta) {
  clearState(gd);
  const sd = ensureStateDir(gd);
  const full = { version: 2, id: crypto.randomUUID(), startedAt: Date.now(), starting: true, ...meta };
  writeStateFile(sd, 'meta.json', JSON.stringify(full));
  return full;
}

/** meta.json of the state folder, or null. */
const readMeta = (gd) => (safeState(gd) ? readJson(path.join(stateDirOf(gd), 'meta.json')) : null);

/**
 * Once git's command that starts the rebase we asked for has exited: write meta.id into
 * rebase-merge/ (when it is there), then drop meta.starting. From then on a meta.json left from
 * an earlier rebase of the same commit (aborted in a terminal) never makes a terminal's rebase
 * look like ours. git ignores the file and removes it with the folder. Never called while git
 * runs: a file created while git removes the folder would leave the folder behind.
 */
function markOurs(gd) {
  const dir = path.join(gd, 'rebase-merge');
  const meta = readMeta(gd);
  if (!meta || typeof meta.id !== 'string') return;
  if (isRealDir(dir) && !exists(path.join(dir, OURS_MARKER))) writeStateFile(dir, OURS_MARKER, meta.id);
  if (meta.starting) {
    const rest = { ...meta };
    delete rest.starting;
    writeStateFile(stateDirOf(gd), 'meta.json', JSON.stringify(rest));
  }
}

// ---------------------------------------------------------------- reading the state

/**
 * The repo's comment string for commit messages: {char, auto}. `core.commentChar` /
 * `core.commentString` (the last one set wins, as in git); 'auto' (git picks a character per
 * message only while `git commit` prepares one) and anything invalid read as '#', which is what
 * git writes its "Conflicts:" notes with in those cases.
 */
async function commentConfig(cwd) {
  const raw = await tryOut(cwd, ['config', '-z', '--get-regexp', '^core\\.comment(char|string)$']);
  const entries = (raw || '').split('\0').filter(Boolean);
  const last = entries[entries.length - 1];
  const nl = last ? last.indexOf('\n') : -1;
  const value = nl >= 0 ? last.slice(nl + 1) : null;
  if (value !== null && value.toLowerCase() === 'auto') return { char: '#', auto: true };
  return { char: value && !value.includes('\n') && value.trim() ? value : '#', auto: false };
}

/**
 * Config for a command whose message comments git writes with '#' (rebases we start, a merge
 * commit under core.commentChar=auto): commit.cleanup=strip then removes exactly those lines.
 */
const HASH_COMMENTS = Object.freeze(['-c', 'core.commentChar=#']);

/** The repo's comment string ('#' unless core.commentChar / commentString says otherwise). */
const commentChar = async (cwd) => (await commentConfig(cwd)).char;

/** Subject of commit `sha`, or null. */
async function subjectOf(cwd, sha) {
  if (!sha) return null;
  const raw = await tryOut(cwd, ['log', '-1', '--no-walk', '--format=%s', sha, '--']);
  return raw === null ? null : raw.replace(/\n$/, '');
}

/**
 * True when continuing the merge backend's rebase in `dir` (rebase-merge/) would run a command
 * from its todo (EXEC_LINE), or when the todo is there but can't be read whole (too big, a
 * symlink): then nobody can tell, so it counts.
 */
function todoRunsCommands(dir, raw) {
  return raw === null ? exists(path.join(dir, 'git-rebase-todo')) : EXEC_LINE.test(raw);
}

/**
 * The merge backend's progress (rebase-merge/): {step, current, foreign, runsCommands, message,
 * rescheduled}. `rescheduled`: the command git was running is back at the top of the todo (it
 * couldn't run it, e.g. an untracked file in the way, and will retry it on continue).
 */
function readMergeBackend(f, dir) {
  const done = todoLines(f('done'));
  const rawTodo = f('git-rebase-todo');
  const todo = todoLines(rawTodo);
  const commits = (lines) => lines.filter((l) => COMMIT_CMDS.has(l.cmd)).length;
  const n = int(f('msgnum'));
  const end = int(f('end'));
  const total = commits(done) + commits(todo);
  const last = done[done.length - 1];
  return {
    step: total || n === null || end === null ? { done: commits(done), total } : { done: Math.min(n, end), total: end },
    current: last ? { cmd: last.cmd, sha: last.sha } : null,
    foreign: todo.some((l) => FOREIGN_CMDS.has(l.cmd)),
    runsCommands: todoRunsCommands(dir, rawTodo),
    message: f('message'),
    malformed: false,
    rescheduled: !!last && !!todo[0] && todo[0].cmd === last.cmd && todo[0].sha === last.sha,
  };
}

/** The apply backend's progress (rebase-apply/): {step, current, foreign, message, malformed}. */
function readApplyBackend(f, rebaseHead) {
  const next = int(f('next'));
  const last = int(f('last'));
  const sha = oid(f('original-commit')) || rebaseHead;
  return {
    step: next !== null && last !== null ? { done: Math.min(next, last), total: last } : { done: 0, total: 0 },
    current: sha ? { cmd: 'pick', sha } : null,
    foreign: false,
    runsCommands: false,
    message: f('final-commit'),
    malformed: next === null || last === null,
  };
}

/**
 * Why the rebase stopped. A reword whose commit hook failed leaves `amend` too (continue then
 * amends): the recorded hook / signing failure wins over 'edit'. A rescheduled command (see
 * readMergeBackend) is 'other', whatever REBASE_HEAD says.
 */
function classifyStop({ conflicted, recorded, amend, malformed, rescheduled, backend, rebaseHead, staged }) {
  if (conflicted) return 'conflict';
  if (recorded) return recorded.kind === 'hook' ? 'hook' : 'other';
  if (amend) return 'edit';
  if (malformed || rescheduled) return 'other';
  if (backend === 'merge' && rebaseHead) return staged ? 'conflict' : 'empty'; // a pick stopped (resolved, or nothing left)
  if (backend === 'apply' && staged) return 'conflict';
  return 'other';
}

/**
 * RebaseState (plan §3.4) of the rebase in progress, or null when `st.state` isn't 'rebasing'.
 * `st`: the status fields read so far ({state, oid, staged, conflicted}); `gd`: the absolute git
 * dir; `autostash`: our autostash (sha or null). Never throws for odd files: anything malformed
 * gives stop 'other'.
 * `ours`: meta.json's origHead is rebase-merge/orig-head and meta.id is in rebase-merge/ (a meta
 * without an id, from an older version, needs only the origHead; while meta.starting is set, a
 * rebase-merge/ without any marker is ours too: see markOurs).
 */
async function readRebase(cwd, st, gd, autostash = null) {
  if (st.state !== 'rebasing') return null;
  const mergeDir = path.join(gd, 'rebase-merge');
  const backend = isRealDir(mergeDir) ? 'merge' : 'apply';
  const dir = backend === 'merge' ? mergeDir : path.join(gd, 'rebase-apply');
  const f = (name) => readSmall(path.join(dir, name));

  const headName = (f('head-name') || '').trim();
  const onto = oid(f('onto'));
  const origHead = oid(f('orig-head'));
  const rebaseHead = oid(readSmall(path.join(gd, 'REBASE_HEAD')));
  const meta = readMeta(gd);
  const marker = f(OURS_MARKER);
  const ours = backend === 'merge' && !!meta && meta.origHead === origHead
    && (meta.id === undefined || marker === meta.id || (meta.starting === true && marker === null));
  const prog = backend === 'merge' ? readMergeBackend(f, dir) : readApplyBackend(f, rebaseHead);
  const char = ours ? '#' : await commentChar(cwd);
  const current = prog.current && { ...prog.current, subject: await subjectOf(cwd, prog.current.sha) };

  const rec = safeState(gd) ? readJson(path.join(stateDirOf(gd), 'stop.json')) : null;
  const recorded = rec && rec.origHead === origHead && rec.head === st.oid ? rec : null;
  const stop = classifyStop({
    conflicted: st.conflicted.length > 0, recorded, amend: backend === 'merge' && exists(path.join(dir, 'amend')),
    malformed: !headName || !onto || !origHead || prog.malformed, rescheduled: !!prog.rescheduled, backend, rebaseHead, staged: st.staged.length > 0,
  });

  return {
    backend,
    interactive: backend === 'merge' && exists(path.join(dir, 'interactive')),
    ours,
    branch: branchOf(headName),
    onto,
    origHead,
    ontoName: ours && typeof meta.ontoName === 'string' && meta.ontoName ? meta.ontoName : null,
    step: prog.step,
    current,
    stop,
    stopMessage: stripComments(prog.message, char),
    conflicted: st.conflicted.length,
    todoEditable: ours && !prog.foreign,
    // The rest of the todo runs shell commands (exec lines): Continue and Skip are refused
    // (ops-rebase.js, rebase.js), whoever started it. We never write one, and "ours" is told from
    // files in the git dir, which a folder from elsewhere can carry as well.
    runsCommands: prog.runsCommands,
    autostash,
    // Additions to the plan's shape: the commit being replayed (REBASE_HEAD) at a conflict / edit
    // stop, the output of a hook (or signing) failure that stopped it, and git's own --autostash
    // of an external rebase.
    stoppedSha: rebaseHead,
    hookOutput: recorded && typeof recorded.output === 'string' ? recorded.output : null,
    signingFailed: !!recorded && recorded.kind === 'signing',
    gitAutostash: exists(path.join(dir, 'autostash')),
  };
}

module.exports = {
  oid, todoLines, readRebase, commentConfig, commentChar, HASH_COMMENTS,
  plDir, stateDirOf, ensurePlDir, ensureStateDir, writeStateFile, removeFileIn, clearState, removeStateFile,
  preparedMessage, hasMessages, writeMeta, readMeta, markOurs,
};
