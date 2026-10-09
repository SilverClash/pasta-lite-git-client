'use strict';
// Undo / redo driven entirely by the HEAD reflog (no separate state file).
//
// Reflog append: `git reflog write HEAD <oid> <oid> <msg>` (git >= 2.51). It appends to the HEAD
// log only (never the branch log), moves no ref, works in detached HEAD and on any ref backend.
// `update-ref -m msg HEAD X X` was rejected: in detached HEAD git silently skips the no-op update
// and writes nothing. Appending to logs/HEAD by hand would bypass locking and break on reftable.
//
// Entry kinds (M = the original action's reflog message):
//   M            normal action, e.g. "commit: fix", "checkout: moving from a to b"
//   custom       "pasta-lite discard [<sha>] <n> file(s)",
//                "pasta-lite delete-branch <name> <upstream|-> [<sha>]"
//                (also read: "discard: ..." / "delete_branch: ...", what versions before wrote)
//   undo: M      written when M is undone
//   redo: M      written when M is redone; counts as a fresh occurrence of M
// Reversals write their message through a channel we control:
//   commit        update-ref -m (logs to branch + HEAD)
//   checkout      GIT_REFLOG_ACTION=<msg> git checkout (checkout uses the env value verbatim)
//   custom kinds  reflog write
//
// Walk (newest -> oldest) with a list of pending cancels:
//   live `undo: M` -> pending cancel of the next older action M
//   live `redo: M` -> pending cancel of the next older `undo: M`, and acts as action M
//   an entry matching a pending cancel is cancelled: skipped, and pushes nothing itself
// No-op entries (old == new) are skipped: `reset: moving to HEAD` (stash, merge --abort) would
// otherwise block undo after every autostash; `checkout: moving from X to X` (bisect reset,
// re-checkout of the current branch) would offer a pointless "Undo checkout".
// Undo target: first live action (normal or redo); unsupported -> stop, undo = null.
// Redo target: first live `undo: M`, passing only over live `redo:` entries; anything else
// (a normal action) means redo = null. So redo is only offered directly after undos, repeated
// redo walks back up a chain of undos, and undoing a redo re-offers it.
//
// Discard backups (withDiscardBackup): two commits built in a temp index (copy of the real index
// with the discarded paths replaced by their raw working-tree bytes: no clean filter, no CRLF
// conversion, links as links; restoring writes those bytes back directly, so nothing is lost to
// filters or core.autocrlf):
//   before  worktree state of the paths before the discard (parent: HEAD, or root if unborn)
//   after   worktree state right after the discard (parent: before), message body = JSON path list
// kept alive by refs/pasta-lite/backups/<after> (reflog messages don't protect objects from gc)
// and logged as "pasta-lite discard [<after>] <n> file(s)". Pruning old backups is out of scope.
// Undo is offered only while the recorded paths still match `after` exactly (content, mode and
// existence, compared as trees built the same way), and restores `before`; redo only while they
// match `before`, and restores `after`. So edits made after a discard are never overwritten, and a
// hunk-level discard redoes exactly (other hunks survive). When the reflog target is a discard
// but the files changed, getState reports undoBlocked / redoBlocked with a reason instead.
// Backup commits always use the fixed identity "Pasta Lite <pasta-lite@localhost>": they are
// internal objects, and this keeps discard working in environments with no identity configured.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  run, out, tryOut, kindError, withSignal, lsUntracked, LITERAL_ENV,
} = require('./exec');
const { headState, repoState, resolveRoot, isBare } = require('./repo-dirs');
const { worktreeGuard, writeNoFollow } = require('./worktree-fs');
const { isAtOrUnder } = require('./fs-paths');
const git = require('./git');
const { isZero, sha7, OID, fullBranch } = require('./gitref');
const { parseStageEntries, parseNulRecords } = require('./porcelain');
const { zeroOid } = require('./git-reads');

const {
  BACKUP_REF, BACKUP_BEFORE_SUBJECT: BEFORE_SUBJECT, BACKUP_AFTER_SUBJECT: AFTER_SUBJECT, BACKUP_IDENT,
  REFLOG_DISCARD, REFLOG_DELETE_BRANCH,
} = require('./namespace');

// The custom kinds also match the "discard:" / "delete_branch:" prefixes earlier versions wrote:
// those entries stay in users' HEAD reflogs (and their undo:/redo: pairs), so undo history made
// before the rename keeps working. Only the new form is written.
const RE = {
  commit: /^commit(?: \((amend)\))?: (.*)$/s,
  checkout: /^checkout: moving from (\S+) to (\S+)$/,
  discard: new RegExp(`^(?:${REFLOG_DISCARD}|discard:) \\[([0-9a-f]+)\\] (\\d+) file\\(s\\)$`),
  deleteBranch: new RegExp(`^(?:${REFLOG_DELETE_BRANCH}|delete_branch:) (\\S+) (\\S+) \\[([0-9a-f]+)\\]$`),
};

const short = (s) => (OID.test(s) ? sha7(s) : s);
const parentOf = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');

const NOOP_CHECKOUT = /^checkout: moving from (.+) to \1$/;
const isNoop = (e) => e.old === e.new && (e.message === 'reset: moving to HEAD' || NOOP_CHECKOUT.test(e.message));

// ---- repo state -------------------------------------------------------------------------------

/** The commit branch `name` points at, or null. */
const branchTip = (cwd, name) => git.resolveCommit(cwd, fullBranch(name));

/** True when object `sha` exists and peels to a `type` ('commit', 'tree'). */
const objectExists = async (cwd, sha, type = 'commit') => (await git.verify(cwd, `${sha}^{${type}}`)) !== null;

/** Append a HEAD reflog entry without moving any ref. `at`: HEAD's sha when the caller knows it. */
async function appendReflog(cwd, message, at) {
  const sha = at || (await headState(cwd)).sha || (await zeroOid(cwd));
  await run(cwd, ['reflog', 'write', 'HEAD', sha, sha, message]);
}

// ---- reflog reading ---------------------------------------------------------------------------

/** HEAD reflog, newest first: [{old, new, message}]. */
async function readReflog(cwd) {
  const root = await resolveRoot(cwd);
  const file = path.resolve(root, (await out(root, ['rev-parse', '--git-path', 'logs/HEAD'])).trim());
  let text = null;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e; // else reftable, or no log yet
  }
  if (text !== null) {
    const entries = [];
    for (const line of text.split('\n')) {
      // "<old> <new> <who> <when>\t<message>" (no tab: an empty message). `[^\t]*` can't run into
      // the tab, so the match is linear (`[^\t]*\t?(.*)` backtracked quadratically on a long line).
      const m = /^([0-9a-f]+) ([0-9a-f]+) [^\t]*(?:\t(.*))?$/.exec(line);
      if (m) entries.push({ old: m[1], new: m[2], message: m[3] ?? '' });
    }
    return entries.reverse();
  }
  // Fallback (reftable): no old-oid placeholder, so pair each entry with the next older one.
  const raw = await tryOut(root, ['reflog', 'show', '--format=%H%x00%gs%x00', 'HEAD']);
  if (!raw) return [];
  const rows = parseNulRecords(raw, 2);
  const zero = await zeroOid(root);
  return rows.map(([sha, message], i) => ({ old: rows[i + 1] ? rows[i + 1][0] : zero, new: sha, message }));
}

const PARSERS = [
  [RE.commit, (m) => ({ action: 'commit', amend: !!m[1], subject: m[2] })],
  [RE.checkout, (m) => ({ action: 'checkout', from: m[1], to: m[2] })],
  [RE.discard, (m) => ({ action: 'discard', sha: m[1], count: Number(m[2]) })],
  [RE.deleteBranch, (m) => ({ action: 'delete_branch', name: m[1], upstream: m[2] === '-' ? null : m[2], sha: m[3] })],
];

/** Classify a message (without undo:/redo: prefix) into a supported action, or null. */
function parseAction(msg) {
  if (msg.startsWith('commit (initial): ')) return null; // nothing to move back to
  for (const [re, build] of PARSERS) {
    const m = re.exec(msg);
    if (m) return build(m);
  }
  return null;
}

function describe(verb, p) {
  switch (p.action) {
    case 'commit': return `${verb} ${p.amend ? 'amend of' : 'commit'} '${p.subject}'`;
    case 'checkout': return `${verb} checkout of ${short(p.to)}`;
    case 'discard': return `${verb} discard of ${p.count} file${p.count === 1 ? '' : 's'}`;
    case 'delete_branch': return `${verb} delete of branch ${p.name}`;
    default: return verb;
  }
}

/** What a reflog message records: an 'undo', a 'redo' (by their prefix) or a 'normal' action. */
function reflogKind(message) {
  if (message.startsWith('undo: ')) return 'undo';
  return message.startsWith('redo: ') ? 'redo' : 'normal';
}

/** Walk the reflog and find the raw undo and redo candidates (before precondition checks). */
function findTargets(entries) {
  const pending = []; // {kind: 'action'|'undo', msg}
  const cancel = (kind, msg) => {
    for (let i = pending.length - 1; i >= 0; i--) {
      if (pending[i].kind === kind && pending[i].msg === msg) { pending.splice(i, 1); return true; }
    }
    return false;
  };
  let undo = null;
  let redo = null;
  let redoOpen = true; // still scanning the leading run of undo/redo entries
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (isNoop(e)) continue;
    const kind = reflogKind(e.message);
    const msg = kind === 'normal' ? e.message : e.message.slice(6);
    if (cancel(kind === 'undo' ? 'undo' : 'action', msg)) continue;
    if (kind === 'undo') {
      if (redoOpen) redo = { entry: { ...e, index: i }, msg };
      redoOpen = false;
      pending.push({ kind: 'action', msg });
    } else {
      if (kind === 'redo') pending.push({ kind: 'undo', msg });
      else redoOpen = false;
      if (!undo) undo = { entry: { ...e, index: i }, msg };
    }
    if (undo && !redoOpen) break;
  }
  return { undo, redo };
}

// ---- preconditions + operations per action ------------------------------------------------------
// For undo, the candidate entry is the action (old -> new). For redo it is the undo entry, whose
// old/new are swapped relative to the action. Either way we go from = entry.new -> to = entry.old.

async function checkCommit(cwd, from, to) {
  const head = await headState(cwd);
  return head.sha === from && !isZero(to) && (await objectExists(cwd, to));
}

async function doCommit(cwd, from, to, message) {
  const head = await headState(cwd);
  const args = head.branch
    ? ['update-ref', '-m', message, `refs/heads/${head.branch}`, to, from]
    : ['update-ref', '--no-deref', '-m', message, 'HEAD', to, from];
  await run(cwd, args);
}

// Checkout: undo goes to p.from (expected current branch p.to), redo the other way round.
async function checkCheckout(cwd, from, to, fromName) {
  const head = await headState(cwd);
  if (head.sha !== from || !(await objectExists(cwd, to))) return false;
  return head.branch ? head.branch === fromName : true;
}

async function doCheckout(cwd, to, message, toName) {
  const args = (await branchTip(cwd, toName))
    ? ['checkout', '-q', '--no-guess', toName, '--']
    : ['checkout', '-q', '--detach', to, '--'];
  await run(cwd, args, { env: { GIT_REFLOG_ACTION: message } });
}

// ---- discard snapshots --------------------------------------------------------------------------

/** f is one of `paths` or inside one of them (a recorded directory). */
function pathMatcher(paths) {
  const set = new Set(paths.map((p) => p.replace(/\/+$/, '')));
  return (f) => {
    for (let q = f; q; q = parentOf(q)) if (set.has(q)) return true;
    return false;
  };
}

const COPY_INDEX_TRIES = 5;

/**
 * Copy the index file `src` to `dst`, giving the copy the source's mtime rounded down to the
 * second. Git's racy-entry check compares entry mtimes with the index mtime; a fresh mtime on the
 * copy would make a same-size edit made right after staging look clean. The mtime is taken
 * before the copy and the source is stat'ed again after it: if git replaced the index meanwhile
 * (mtime, size or inode changed), the copied content may be newer than that mtime, so retry. If
 * it keeps changing, the copy gets mtime 1 (not 0: git ignores a zero index timestamp), so
 * every entry counts as racy and is re-hashed (slower, never wrong).
 * `fsx` is `fs` or a stand-in with statSync / copyFileSync / utimesSync (tests).
 * @returns {number} the mtime (seconds) given to the copy
 */
function copyIndex(fsx, src, dst, tries = COPY_INDEX_TRIES) {
  const same = (a, b) => a.mtimeMs === b.mtimeMs && a.size === b.size && a.ino === b.ino;
  let secs = 1;
  for (let i = 0; i < tries; i++) {
    const pre = fsx.statSync(src);
    fsx.copyFileSync(src, dst);
    if (same(pre, fsx.statSync(src))) {
      secs = Math.floor(pre.mtimeMs / 1000);
      break;
    }
  }
  fsx.utimesSync(dst, secs, secs);
  return secs;
}

/** Test instrumentation: how many snapshots were built (getState caches them, see checkDiscard). */
const stats = { snapshots: 0 };

/**
 * {abs, st} (lstat) of root-relative `rel`, or null when it is missing or lies beyond a symbolic
 * link (git treats such a path as deleted and never reads through the link).
 */
function lstatIn(guard, rel) {
  try {
    const abs = guard.check(rel, { allowFinalLink: true });
    const st = fs.lstatSync(abs, { throwIfNoEntry: false });
    return st ? { abs, st } : null;
  } catch (e) {
    if (e.kind === 'symlink' || e.code === 'ENOTDIR') return null;
    throw e;
  }
}

// `hash-object --stdin-paths` reads one path per line (dropping a final CR) and unquotes a leading '"'.
const stdinPath = (p) => (/(?:^")|[\n\r]/.test(p)
  ? `"${p.replace(/[\\"]/g, '\\$&').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"` : p);

/**
 * Tree of the current index with the raw working-tree state of `paths` (root-relative files or
 * directories) applied, built in a temp copy of the index; the real index is never touched.
 * Every index entry under the paths, and every file git lists as untracked there, is replaced by
 * the bytes on disk (`hash-object --no-filters`: no clean filter, no CRLF conversion; a link is
 * stored as a link, the executable bit as 100755) or removed when it is gone. A submodule entry
 * is kept as it is. On Windows, where the file system has no executable bit, a file keeps its
 * index entry's mode, as `git add` does there.
 * @returns {Promise<{tree: string, found: number}>} found: how many index entries / files the
 *   paths matched (0: none of them exists in the index or on disk).
 */
async function snapshotTree(root, paths) {
  stats.snapshots++;
  const realIndex = path.resolve(root, (await out(root, ['rev-parse', '--git-path', 'index'])).trim());
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-idx-'));
  const idx = path.join(tmp, 'index');
  try {
    if (fs.existsSync(realIndex)) copyIndex(fs, realIndex, idx);
    const env = { ...LITERAL_ENV, GIT_INDEX_FILE: idx };
    const inPaths = pathMatcher(paths);
    const modes = new Map(); // index entries under the paths: path -> mode
    for (const e of parseStageEntries(await out(root, ['ls-files', '-s', '-z'], { env }))) {
      if (inPaths(e.path)) modes.set(e.path, e.mode);
    }
    const guard = await worktreeGuard(root);
    const cand = new Set(modes.keys());
    const dirs = [];
    for (const p of paths) {
      const rel = p.replace(/\/+$/, '');
      const hit = lstatIn(guard, rel);
      if (!hit) continue;
      if (!hit.st.isDirectory()) cand.add(rel);
      else if (modes.get(rel) !== '160000') dirs.push(rel);
    }
    for (const f of await lsUntracked(root, dirs, { env })) cand.add(f); // recorded directories: their untracked files too
    if (!cand.size) return { tree: (await out(root, ['write-tree'], { env })).trim(), found: 0 };

    // Remove every candidate first (all stages; lets a file become a directory and back), then
    // add what is on disk.
    const zero = await zeroOid(root);
    const records = [...cand].map((f) => `0 ${zero}\t${f}`);
    // The executable bit on disk is recorded, whatever core.fileMode says (the backup is of the
    // files as they are, and undo puts back the +x a discard took away), but not on Windows:
    // Node reports none there, so every file would read as 100644 (and Git for Windows sets
    // core.fileMode=false in the repos it creates).
    const trustExec = process.platform !== 'win32';
    const files = [];
    for (const f of cand) {
      const hit = lstatIn(guard, f);
      if (!hit) continue;
      if (hit.st.isSymbolicLink()) {
        const target = fs.readlinkSync(hit.abs, { encoding: 'buffer' });
        const sha = (await out(root, ['hash-object', '-w', '--no-filters', '--stdin'], { input: target })).trim();
        records.push(`120000 ${sha}\t${f}`);
      } else if (hit.st.isFile()) {
        const exec = trustExec ? hit.st.mode & 0o111 : modes.get(f) === '100755';
        files.push([f, exec ? '100755' : '100644']);
      } else if (modes.get(f) === '160000') {
        records.splice(records.indexOf(`0 ${zero}\t${f}`), 1); // submodule: keep its entry
      }
    }
    if (files.length) {
      const input = `${files.map(([f]) => stdinPath(f)).join('\n')}\n`;
      const shas = (await out(root, ['hash-object', '-w', '--no-filters', '--stdin-paths'], { input })).split('\n');
      files.forEach(([f, mode], i) => records.push(`${mode} ${shas[i]}\t${f}`));
    }
    await run(root, ['update-index', '-z', '--index-info'], { env, input: `${records.join('\0')}\0` });
    return { tree: (await out(root, ['write-tree'], { env })).trim(), found: cand.size };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function commitTree(root, tree, parent, message) {
  const args = ['commit-tree', '--no-gpg-sign', tree, ...(parent ? ['-p', parent] : [])];
  return (await out(root, args, { input: message, env: BACKUP_IDENT })).trim();
}

/**
 * Entries under `paths` that differ from tree a to tree b: [{status A|D|M|T, path, mode, sha}]
 * (mode and sha of the b side).
 */
async function treeDiff(root, a, b, paths) {
  const raw = await out(root, ['diff-tree', '-r', '-z', '--no-renames', a, b]);
  const inPaths = pathMatcher(paths);
  const res = [];
  for (const [meta, f] of parseNulRecords(raw, 2)) {
    const m = /^:\d{6} (\d{6}) [0-9a-f]+ ([0-9a-f]+) ([A-Z])/.exec(meta);
    if (m && inPaths(f)) res.push({ status: m[3], path: f, mode: m[1], sha: m[2] });
  }
  return res;
}

/** {before, paths} of a discard's `after` commit, or null if it is missing or not ours. */
async function backupInfo(root, after) {
  const raw = await tryOut(root, ['log', '-1', '--format=%P%x00%s%x00%b', `${after}^{commit}`]);
  if (!raw) return null;
  const [parents, subject, body] = raw.split('\0');
  if (subject !== AFTER_SUBJECT || !parents.trim()) return null;
  try {
    const { paths } = JSON.parse(body.trim());
    return Array.isArray(paths) && paths.length ? { before: parents.trim().split(' ')[0], paths } : null;
  } catch {
    return null;
  }
}

// getState runs on every refresh; building the snapshot reads every backed-up file. The last one
// is reused while the index file and every backed-up path look exactly the same (lstat: mtime,
// ctime, size, inode, mode). Not used for a recorded directory (a file deep inside can change
// without its lstat changing), and never by perform, which always re-reads.
const snapCache = new Map(); // root -> {key, tree}

function snapshotKey(root, indexFile, sha, paths) {
  const st = (p) => {
    try {
      const s = fs.lstatSync(p, { throwIfNoEntry: false });
      return s ? [s.mtimeMs, s.ctimeMs, s.size, s.ino, s.mode] : null;
    } catch (e) {
      if (e.code === 'ENOTDIR') return null;
      throw e;
    }
  };
  const parts = [sha, st(indexFile)];
  for (const p of paths) {
    const s = st(path.join(root, p));
    if (s && (s[4] & fs.constants.S_IFMT) === fs.constants.S_IFDIR) return null;
    parts.push(s);
  }
  return JSON.stringify(parts);
}

async function currentSnapshot(root, sha, paths, fresh) {
  const indexFile = path.resolve(root, (await out(root, ['rev-parse', '--git-path', 'index'])).trim());
  const key = snapshotKey(root, indexFile, sha, paths); // taken before the snapshot: a change during it misses next time
  const hit = snapCache.get(root);
  if (!fresh && key && hit && hit.key === key && (await objectExists(root, hit.tree, 'tree'))) return hit.tree;
  const { tree } = await snapshotTree(root, paths);
  if (key) snapCache.set(root, { key, tree });
  else snapCache.delete(root);
  return tree;
}

// Undo expects the worktree at `after` and goes to `before`; redo the reverse.
async function checkDiscard(cwd, p, dir, { fresh = false } = {}) {
  const root = await resolveRoot(cwd);
  const b = await backupInfo(root, p.sha);
  if (!b) return { ok: false };
  const [expect, target] = dir === 'undo' ? [p.sha, b.before] : [b.before, p.sha];
  const current = await currentSnapshot(root, p.sha, b.paths, fresh);
  if ((await treeDiff(root, `${expect}^{tree}`, current, b.paths)).length) {
    return { ok: false, blocked: dir === 'undo' ? 'Files changed since the discard' : 'Files changed since the undo' };
  }
  return { ok: true, ctx: { root, current, target, paths: b.paths } };
}

/**
 * Delete root-relative `rel` (a file or link, never a directory) and prune now-empty parents,
 * like git does. `guard` is worktree-fs.worktreeGuard: a path through a symlinked (or dangling) parent,
 * or one outside the worktree, throws (kind 'symlink' / 'outside') before anything is deleted.
 */
function removeFile(guard, rel) {
  const abs = guard.check(rel, { allowFinalLink: true });
  let st = null;
  try { st = fs.lstatSync(abs); } catch { /* already gone */ }
  // unlink, not rmSync: Node's rmSync on Windows returns without removing a symlink whose target
  // doesn't exist. A final symlink is removed itself, not its target.
  if (st && !st.isDirectory()) fs.unlinkSync(abs);
  for (let dir = path.dirname(abs); dir !== guard.root && isAtOrUnder(dir, guard.root); dir = path.dirname(dir)) {
    try { fs.rmdirSync(dir); } catch { break; } // not empty, or gone
  }
}

/**
 * Write blob `buf` (mode `mode`) to root-relative `rel`, like a checkout without filters: a link
 * is created as a link, a regular file gets its bytes and executable bit. Whatever is in the way
 * (another file type, a link, an empty directory) is removed first; a non-empty directory is not
 * (the call fails). Parents are created as real directories; the guard refuses symlinked ones.
 */
function putFile(guard, rel, mode, buf) {
  let abs = guard.check(rel, { allowFinalLink: true });
  const link = mode === '120000';
  const st = fs.lstatSync(abs, { throwIfNoEntry: false });
  if (st && !st.isFile()) {
    if (st.isDirectory()) fs.rmdirSync(abs);
    else fs.unlinkSync(abs); // a link itself, never its target (unlink: see removeFile)
  } else if (st && link) {
    fs.unlinkSync(abs);
  }
  if (st && st.isFile() && !link) {
    writeNoFollow(abs, buf, { exec: mode === '100755' });
    return;
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  abs = guard.check(rel, { allowFinalLink: true }); // mkdir may have raced with a swapped-in parent link
  if (link) fs.symlinkSync(buf, abs);
  else writeNoFollow(abs, buf, { create: true, mode: mode === '100755' ? 0o755 : 0o644 });
}

const BLOB_CHUNK = 64 * 1024 * 1024;

/** Yields Map(sha -> Buffer) of the blobs `shas`, one `cat-file --batch` per ~BLOB_CHUNK bytes. */
async function* blobChunks(root, shas) {
  const uniq = [...new Set(shas)];
  if (!uniq.length) return;
  const sizes = new Map();
  for (const line of (await out(root, ['cat-file', '--batch-check'], { input: `${uniq.join('\n')}\n` })).split('\n')) {
    const [sha, type, size] = line.split(' ');
    if (!sha) continue;
    if (type !== 'blob') throw new Error(`Backup object ${sha} is missing`);
    sizes.set(sha, Number(size));
  }
  const read = async (list, bytes) => {
    const buf = await out(root, ['cat-file', '--batch'], {
      input: `${list.join('\n')}\n`, encoding: 'buffer', maxBytes: bytes + list.length * 200 + 4096,
    });
    const res = new Map();
    let pos = 0;
    for (const sha of list) {
      const start = buf.indexOf(10, pos) + 1; // "<sha> blob <size>\n<content>\n"
      res.set(sha, buf.subarray(start, start + sizes.get(sha)));
      pos = start + sizes.get(sha) + 1;
    }
    return res;
  };
  let list = [];
  let bytes = 0;
  for (const sha of uniq) {
    if (list.length && bytes + sizes.get(sha) > BLOB_CHUNK) {
      yield await read(list, bytes);
      list = [];
      bytes = 0;
    }
    list.push(sha);
    bytes += sizes.get(sha);
  }
  yield await read(list, bytes);
}

/** Move the recorded paths from the verified current tree to the target snapshot (raw bytes). */
async function applyDiscard({ root, current, target, paths }) {
  const changes = await treeDiff(root, current, `${target}^{tree}`, paths);
  const guard = await worktreeGuard(root);
  const deletes = changes.filter((c) => c.status === 'D').map((c) => c.path);
  const puts = changes.filter((c) => c.status !== 'D' && c.mode !== '160000'); // submodules: not restorable
  // Refuse up front, before anything is changed.
  for (const f of [...deletes, ...puts.map((c) => c.path)]) guard.check(f, { allowFinalLink: true });
  // Deletions first, so a file can be replaced by a directory of the same name and vice versa.
  for (const f of deletes) removeFile(guard, f);
  for await (const blobs of blobChunks(root, puts.map((c) => c.sha))) {
    for (const c of puts) if (blobs.has(c.sha)) putFile(guard, c.path, c.mode, blobs.get(c.sha));
  }
}

// ---- branch delete ------------------------------------------------------------------------------

/** A branch name parsed from the reflog is data: it must be a valid name (never an option). */
async function validBranchName(cwd, name) {
  try {
    await git.validateBranchName(cwd, name);
    return true;
  } catch (e) {
    if (e.kind === 'invalid-args') return false;
    throw e;
  }
}

async function checkDeleteBranch(cwd, p, forRedo) {
  if (!(await validBranchName(cwd, p.name))) return false;
  const tip = await branchTip(cwd, p.name);
  if (!forRedo) return tip === null && (await objectExists(cwd, p.sha));
  return tip !== null && tip.startsWith(p.sha) && !(await git.isCurrentBranch(cwd, p.name));
}

/** Recreate the branch (update-ref with an empty old value: fails if it exists). {upstreamRestored?}. */
async function undoDeleteBranch(cwd, p) {
  await run(cwd, ['update-ref', `refs/heads/${p.name}`, p.sha, '']);
  if (!p.upstream) return {};
  // The upstream may be gone: the branch is back either way, and the result says so.
  return { upstreamRestored: (await tryOut(cwd, ['branch', `--set-upstream-to=${p.upstream}`, p.name])) !== null };
}

async function redoDeleteBranch(cwd, p) {
  await run(cwd, ['branch', '-D', p.name]);
}

// ---- handlers -----------------------------------------------------------------------------------
// check(cwd, parsed, {from, to}, dir, {fresh}) -> {ok, blocked?, ctx?};
// apply(cwd, target, message, dir) -> extra result fields or undefined.

const HANDLERS = {
  commit: {
    check: async (cwd, p, t) => ({ ok: await checkCommit(cwd, t.from, t.to) }),
    apply: (cwd, t, message) => doCommit(cwd, t.from, t.to, message),
  },
  checkout: {
    check: async (cwd, p, t, dir) => ({ ok: await checkCheckout(cwd, t.from, t.to, dir === 'undo' ? p.to : p.from) }),
    apply: (cwd, t, message, dir) => doCheckout(cwd, t.to, message, dir === 'undo' ? t.parsed.from : t.parsed.to),
  },
  discard: {
    check: (cwd, p, t, dir, o) => checkDiscard(cwd, p, dir, o),
    apply: async (cwd, t, message) => {
      await applyDiscard(t.ctx);
      await appendReflog(cwd, message);
    },
  },
  delete_branch: {
    check: async (cwd, p, t, dir) => ({ ok: await checkDeleteBranch(cwd, p, dir === 'redo') }),
    apply: async (cwd, t, message, dir) => {
      const res = await (dir === 'undo' ? undoDeleteBranch : redoDeleteBranch)(cwd, t.parsed);
      await appendReflog(cwd, message);
      return res;
    },
  },
};

// ---- target resolution --------------------------------------------------------------------------

/** Resolve a raw candidate: {target, blocked}; target is null unless it can be performed now. */
const none = () => ({ target: null, blocked: null });

// A bare repository can only undo / redo a branch delete: every other reversal moves
// HEAD's branch in a working tree or writes files. Its HEAD reflog can still hold commit entries
// (commits made there before it became bare, or by a tool that logs there): undoing one would
// update-ref the branch a linked worktree may have checked out, so it is blocked with this reason.
const BARE_BLOCKED = 'Needs a working tree (bare repository)';

async function resolve(cwd, cand, dir, o) {
  if (!cand) return none();
  const p = parseAction(cand.msg);
  if (!p) return none();
  if (o.bare && p.action !== 'delete_branch') return { target: null, blocked: BARE_BLOCKED };
  const e = cand.entry;
  const span = { from: e.new, to: e.old };
  const r = await HANDLERS[p.action].check(cwd, p, span, dir, o);
  if (!r.ok) return { target: null, blocked: r.blocked || null };
  const verb = dir === 'undo' ? 'Undo' : 'Redo';
  return {
    target: { action: p.action, description: describe(verb, p), entry: e, parsed: p, msg: cand.msg, ...span, ctx: r.ctx },
    blocked: null,
  };
}

const publicTarget = (t) => t && { action: t.action, description: t.description, entry: t.entry };

/** o.fresh: never reuse a cached discard snapshot (perform). In a bare repo only branch deletes resolve. */
async function targets(cwd, o = {}) {
  const [state, bare] = await Promise.all([repoState(cwd), isBare(cwd)]);
  if (state !== 'clean') return { state, undo: none(), redo: none() };
  const { undo, redo } = findTargets(await readReflog(cwd));
  const ro = { ...o, bare };
  return { state, undo: await resolve(cwd, undo, 'undo', ro), redo: await resolve(cwd, redo, 'redo', ro) };
}

// ---- public API ---------------------------------------------------------------------------------

/**
 * @returns {Promise<{undo: {action, description, entry}|null, redo: same|null, busy: boolean,
 *   undoBlocked: string|null, redoBlocked: string|null}>}
 *   busy: a merge/rebase/am/cherry-pick/revert/sequencer/bisect is in progress.
 *   undoBlocked/redoBlocked: why the reflog's next undo/redo target (a discard) is unavailable
 *   right now, e.g. 'Files changed since the discard'; null otherwise. In a bare repository any
 *   target but a branch delete is blocked with 'Needs a working tree (bare repository)'.
 */
async function getState(cwd) {
  const t = await targets(cwd);
  return {
    undo: publicTarget(t.undo.target),
    redo: publicTarget(t.redo.target),
    busy: t.state !== 'clean',
    undoBlocked: t.undo.blocked,
    redoBlocked: t.redo.blocked,
  };
}

/**
 * @returns {Promise<{action, description, upstreamRestored?}>} upstreamRestored (branch delete
 *   undo with an upstream): false when the branch came back but its upstream could not be set.
 * Errors carry kind 'busy' (operation in progress, extra `state`) or 'nothing' (extra `blocked`).
 * Finding the target can be cancelled (the ambient exec signal); once the reversal starts it runs
 * to the end, cancel or not, so it is never left half done by a cancel. If it fails part way
 * anyway, a discard's error carries `backup` (the backup commit, whose parent holds the state
 * before the discard).
 */
async function perform(cwd, dir) {
  const t = await targets(cwd, { fresh: true });
  if (t.state !== 'clean') {
    throw kindError('busy', `Undo/redo is unavailable while an operation is in progress (${t.state})`, { state: t.state });
  }
  const { target, blocked } = t[dir];
  if (!target) throw kindError('nothing', blocked || `Nothing to ${dir}`, { blocked });
  let extra;
  try {
    extra = await withSignal(undefined, () => HANDLERS[target.action].apply(cwd, target, `${dir}: ${target.msg}`, dir));
  } catch (err) {
    if (target.action === 'discard' && err && typeof err === 'object') {
      try { err.backup = target.parsed.sha; } catch { /* frozen */ }
    }
    throw err;
  }
  return { action: target.action, description: target.description, ...extra };
}

const undo = (cwd) => perform(cwd, 'undo');
const redo = (cwd) => perform(cwd, 'redo');

/**
 * Discard with an undo backup. `paths` are repo-root relative (files or directories); `fn` performs
 * the actual discard (git.discard / hunks.discardSelection) and may touch only those paths.
 * Snapshots the paths before and after `fn`, keeps both (after's parent is before) under
 * refs/pasta-lite/backups/<after> and logs "pasta-lite discard [<after>] <n> file(s)". If `fn`
 * throws, nothing is recorded and the error propagates. If `fn` changed nothing, nothing is
 * recorded.
 * If none of the paths exists (in the index or on disk), throws kind 'stale' before `fn` runs:
 * a destructive fn given paths the snapshot cannot see would leave no backup.
 * @returns {Promise<{result: any, backup: string|null}>} fn's result and the `after` commit sha.
 */
async function withDiscardBackup(cwd, paths, fn) {
  if (!Array.isArray(paths) || !paths.length) throw new TypeError('withDiscardBackup: no paths');
  const root = await resolveRoot(cwd);
  const body = `${JSON.stringify({ paths })}\n`;
  const { tree: beforeTree, found } = await snapshotTree(root, paths);
  if (!found) throw kindError('stale', 'Nothing to discard: none of the paths exists any more');
  const before = await commitTree(root, beforeTree, (await headState(root)).sha, `${BEFORE_SUBJECT}\n\n${body}`);
  const result = await fn();
  const { tree: afterTree } = await snapshotTree(root, paths);
  if (!(await treeDiff(root, beforeTree, afterTree, paths)).length) return { result, backup: null };
  const after = await commitTree(root, afterTree, before, `${AFTER_SUBJECT}\n\n${body}`);
  await run(root, ['update-ref', `${BACKUP_REF}${after}`, after]);
  await appendReflog(root, `${REFLOG_DISCARD} [${after}] ${paths.length} file(s)`);
  return { result, backup: after };
}

/**
 * Log a branch deletion so it can be undone. Call right after deleting the branch. `at`: HEAD's sha
 * when the caller already read it (several deletes in a row: a branch delete never moves HEAD).
 */
async function recordBranchDelete(cwd, { name, sha, upstream }, { at } = {}) {
  await appendReflog(cwd, `${REFLOG_DELETE_BRANCH} ${name} ${upstream || '-'} [${sha}]`, at);
}

module.exports = {
  getState, undo, redo, withDiscardBackup, recordBranchDelete,
  _internal: { copyIndex, removeFile, stats }, // exported for unit tests only
};
