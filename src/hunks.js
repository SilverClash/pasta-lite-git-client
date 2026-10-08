'use strict';
// Unified-diff parsing plus content-based hunk/line staging, unstaging and discarding.
// We never use `git apply`: the new file content is rebuilt in JS from a base text and a
// parsed patch, then written as a blob (index) or as the working file (discard).
//
// Byte safety: file contents and diffs are handled as 'latin1' strings, where each char is one
// byte (0-255), so arbitrary encodings (Latin-1, Shift-JIS, invalid UTF-8) round-trip exactly.
// Use decodeForDisplay() to turn such a string into readable text.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  run, out, kindError, LITERAL_ENV,
} = require('./exec');
const { resolveRoot } = require('./repo-dirs');
const git = require('./git');
const { workdirDiff } = require('./diff-args');
const { worktreeGuard, readNoFollow, writeNoFollow } = require('./worktree-fs');
// The exact-path index / HEAD lookups (shared with the image preview's side resolution).
const { indexEntry, headEntry } = require('./blob-revisions');

const utf8Fatal = new TextDecoder('utf-8', { fatal: true });

/** Decode a latin1 (byte) string for display: UTF-8 when valid, else Latin-1 as is. */
function decodeForDisplay(latin1) {
  const buf = Buffer.from(latin1, 'latin1');
  try {
    return utf8Fatal.decode(buf);
  } catch {
    return latin1;
  }
}

// ---------------------------------------------------------------------------
// Parsing

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Undo git's C-style path quoting ("a\tb", octal escapes are raw bytes). `bytes`: the diff was
 * read as latin1, so each char is a byte and the result is decoded with decodeForDisplay.
 */
function unquote(s, bytes) {
  if (!s.startsWith('"')) return bytes ? decodeForDisplay(s) : s;
  const buf = [];
  const esc = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
  for (let i = 1; i < s.length; i++) {
    const c = s[i];
    if (c === '"') break;
    if (c !== '\\') {
      if (bytes) buf.push(c.charCodeAt(0) & 0xff);
      else buf.push(...Buffer.from(c, 'utf8'));
      continue;
    }
    const n = s[++i];
    if (/[0-7]/.test(n)) { buf.push(parseInt(s.substr(i, 3), 8)); i += 2; }
    else buf.push(esc[n] ?? n.charCodeAt(0));
  }
  const raw = Buffer.from(buf);
  return bytes ? decodeForDisplay(raw.toString('latin1')) : raw.toString('utf8');
}

// "--- a/x", "+++ b/x" or "/dev/null" -> path or null. Git appends a tab to names with spaces.
function headerPath(s, bytes) {
  s = s.replace(/\t$/, '');
  if (s === '/dev/null') return null;
  return unquote(s, bytes).replace(/^[ab]\//, '');
}

// Best-effort split of the "diff --git a/X b/Y" line (exact when X === Y, the usual case).
function gitLinePaths(rest, bytes) {
  if (rest.startsWith('"')) {
    const m = rest.match(/^("(?:[^"\\]|\\.)*") (.*)$/);
    if (m) return [headerPath(m[1], bytes), headerPath(m[2], bytes)];
  }
  const L = (rest.length - 5) / 2;
  if (Number.isInteger(L) && rest.startsWith('a/') && rest.substr(2 + L, 3) === ' b/' &&
      rest.substr(2, L) === rest.substr(5 + L)) {
    const p = unquote(rest.substr(2, L), bytes);
    return [p, p];
  }
  const i = rest.lastIndexOf(' b/');
  if (i < 0) { const p = unquote(rest, bytes); return [p, p]; }
  return [headerPath(rest.slice(0, i), bytes), headerPath(rest.slice(i + 1), bytes)];
}

function newFile(encoding = 'utf8') {
  return {
    oldPath: null, newPath: null, isNew: false, isDeleted: false, isBinary: false,
    isRename: false, isCopy: false, oldMode: null, newMode: null, hunks: [], encoding,
  };
}

/**
 * Parse `git diff` output (one or many files).
 * Line `text` has the +/-/space prefix and the "\n" removed; a CR of CRLF content is kept.
 * `encoding: 'latin1'` says `text` was read with encoding 'latin1' (one char per byte): line
 * texts stay byte strings (show them with decodeForDisplay), paths are decoded for display.
 * Each file records the encoding, which fingerprint() needs.
 */
function parsePatch(text, { encoding = 'utf8' } = {}) {
  const bytes = encoding === 'latin1';
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const files = [];
  let file = null;
  const start = () => { file = newFile(encoding); files.push(file); return file; };

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('diff --git ')) {
      const [a, b] = gitLinePaths(l.slice(11), bytes);
      start();
      file.oldPath = a; file.newPath = b;
      continue;
    }
    // Plain unified diff (no "diff --git" line): "---" starts a new file.
    if (l.startsWith('--- ') && (!file || file.hunks.length) && lines[i + 1]?.startsWith('+++ ')) {
      start();
    }
    if (!file) continue;
    if (!applyHeaderLine(file, l, bytes) && HUNK_RE.test(l)) i = parseHunk(lines, i, file); // NOSONAR(S2310): parseHunk consumes the hunk and returns its last line's index
  }
  for (const f of files) {
    if (f.isNew) f.oldPath = null;
    if (f.isDeleted) f.newPath = null;
  }
  return files;
}

// Extended header lines of a file diff: [prefix, apply(file, rest of the line, bytes)].
const HEADER_LINES = [
  ['--- ', (file, rest, bytes) => {
    const p = headerPath(rest, bytes);
    if (p === null) file.isNew = true; else file.oldPath = p;
  }],
  ['+++ ', (file, rest, bytes) => {
    const p = headerPath(rest, bytes);
    if (p === null) file.isDeleted = true; else file.newPath = p;
  }],
  ['new file mode ', (file, rest) => { file.isNew = true; file.newMode = rest; }],
  ['deleted file mode ', (file, rest) => { file.isDeleted = true; file.oldMode = rest; }],
  ['old mode ', (file, rest) => { file.oldMode = rest; }],
  ['new mode ', (file, rest) => { file.newMode = rest; }],
  ['index ', (file, rest) => {
    const m = rest.match(/^\S+ (\d{6})$/);
    if (m) { file.oldMode = file.oldMode || m[1]; file.newMode = file.newMode || m[1]; }
  }],
  ['rename from ', (file, rest, bytes) => { file.isRename = true; file.oldPath = unquote(rest, bytes); }],
  ['rename to ', (file, rest, bytes) => { file.isRename = true; file.newPath = unquote(rest, bytes); }],
  ['copy from ', (file, rest, bytes) => { file.isCopy = true; file.oldPath = unquote(rest, bytes); }],
  ['copy to ', (file, rest, bytes) => { file.isCopy = true; file.newPath = unquote(rest, bytes); }],
  ['Binary files ', (file) => { file.isBinary = true; }],
];

// One extended header line of a file diff ("--- a/x", "new file mode ...", "rename from ...")
// into `file`; false when `l` is not one (a hunk header or something unknown).
function applyHeaderLine(file, l, bytes) {
  if (l === 'GIT binary patch') {
    file.isBinary = true;
    return true;
  }
  const h = HEADER_LINES.find(([prefix]) => l.startsWith(prefix));
  if (!h) return false;
  h[1](file, l.slice(h[0].length), bytes);
  return true;
}

// Parse the hunk whose header is lines[i]; returns the index of its last consumed line.
function parseHunk(lines, i, file) {
  const m = lines[i].match(HUNK_RE);
  const hunk = {
    header: lines[i],
    oldStart: +m[1], oldLines: m[2] === undefined ? 1 : +m[2],
    newStart: +m[3], newLines: m[4] === undefined ? 1 : +m[4],
    lines: [],
  };
  file.hunks.push(hunk);
  let oldRem = hunk.oldLines, newRem = hunk.newLines;
  let oldNo = hunk.oldStart, newNo = hunk.newStart;
  while (i + 1 < lines.length) {
    const l = lines[i + 1];
    const c = l[0];
    if (c === '\\') { // "\ No newline at end of file" applies to the previous line
      const prev = hunk.lines[hunk.lines.length - 1];
      if (prev) prev.noNewlineAtEof = true;
      i++;
      continue;
    }
    if (oldRem <= 0 && newRem <= 0) break;
    const body = l.slice(1);
    if ((c === ' ' || l === '') && oldRem > 0 && newRem > 0) {
      hunk.lines.push({ type: 'context', text: body, oldNo: oldNo++, newNo: newNo++, noNewlineAtEof: false });
      oldRem--; newRem--;
    } else if (c === '-' && oldRem > 0) {
      hunk.lines.push({ type: 'del', text: body, oldNo: oldNo++, newNo: null, noNewlineAtEof: false });
      oldRem--;
    } else if (c === '+' && newRem > 0) {
      hunk.lines.push({ type: 'add', text: body, oldNo: null, newNo: newNo++, noNewlineAtEof: false });
      newRem--;
    } else break; // malformed/truncated hunk
    i++;
  }
  return i;
}

const TYPE_CHAR = { context: ' ', del: '-', add: '+' };

/**
 * Content fingerprint (sha1 hex) of a parsed file diff: binary flag, hunk headers and lines.
 * Hashes bytes, so a utf8-parsed and a latin1-parsed diff of a valid UTF-8 file agree; for
 * non-UTF-8 content only a latin1-parsed diff (what the stage/discard calls compute) matches.
 */
function fingerprint(fileDiff) {
  const h = crypto.createHash('sha1');
  const enc = fileDiff.encoding === 'latin1' ? 'latin1' : 'utf8';
  h.update(fileDiff.isBinary ? 'B\n' : 'T\n');
  for (const hunk of fileDiff.hunks || []) {
    h.update(Buffer.from(`${hunk.header}\n`, enc));
    for (const l of hunk.lines) {
      h.update(Buffer.from(`${TYPE_CHAR[l.type]}${l.text}${l.noNewlineAtEof ? '\n\\' : ''}\n`, enc));
    }
  }
  return h.digest('hex');
}

// ---------------------------------------------------------------------------
// Pure selective apply

// Split keeping each line's terminator ("a\n", "b\r\n", "c").
function splitKeep(text) {
  const res = [];
  let s = 0;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', s)) {
    res.push(text.slice(s, i + 1));
    s = i + 1;
  }
  if (s < text.length) res.push(text.slice(s));
  return res;
}

const stripEol = (l) => l.replace(/\r?\n$/, '');
const stripCr = (s) => s.replace(/\r$/, '');
function eolOf(l) {
  if (l.endsWith('\r\n')) return '\r\n';
  return l.endsWith('\n') ? '\n' : null;
}

// Selection -> Map(hunkIndex -> Set(lineIdx) | 'all'). Throws kind 'stale' on bad indices.
function normalizeSelection(patchFile, selection) {
  const map = new Map();
  for (const s of selection || []) {
    const h = patchFile.hunks[s.hunk];
    if (!Number.isInteger(s.hunk) || !h) throw kindError('stale', `hunk ${s.hunk} no longer exists`);
    if (s.lines == null) { map.set(s.hunk, 'all'); continue; }
    let set = map.get(s.hunk);
    if (set === 'all') continue;
    if (!set) {
      set = new Set();
      map.set(s.hunk, set);
    }
    for (const li of s.lines) {
      if (!Number.isInteger(li) || !h.lines[li]) throw kindError('stale', `line ${li} of hunk ${s.hunk} no longer exists`);
      set.add(li);
    }
  }
  return map;
}

/**
 * Apply the selected part of `patchFile` (a diff base->target) to `baseText`.
 * Forward: base is the diff's old side. reverse: base is the diff's new side and the selected
 * changes are undone (selected adds removed, selected dels restored).
 * Inserted lines keep their own ending (a CR in the patch text is kept, "\n" is appended), so
 * mixed-EOL files are not rewritten. Exception: when the base is the CRLF-smudged form of an LF
 * patch (core.autocrlf working file: base lines end "\r\n" where the patch has no CR), LF
 * lines are inserted with "\r\n".
 */
function applySelection(baseText, patchFile, selection, { reverse = false } = {}) {
  if (patchFile.isBinary) throw kindError('binary', 'cannot stage lines of a binary file');
  const sel = normalizeSelection(patchFile, selection);
  const base = splitKeep(baseText);
  // In reverse the roles swap: 'add' lines exist in base, 'del' lines are the other side.
  const inBase = reverse ? 'add' : 'del';
  const other = reverse ? 'del' : 'add';
  const res = [];
  const inserted = []; // [index in res, patch line] of lines taken from the patch
  let smudged = false;
  let cur = 0;

  patchFile.hunks.forEach((h, hi) => {
    const start = reverse ? h.newStart : h.oldStart;
    const count = reverse ? h.newLines : h.oldLines;
    const at = count === 0 ? start : start - 1;
    if (at < cur || at > base.length) throw kindError('stale', `hunk ${hi} does not match the file`);
    while (cur < at) res.push(base[cur++]);
    const s = sel.get(hi);
    h.lines.forEach((l, li) => {
      const picked = s === 'all' || (s instanceof Set && s.has(li));
      if (l.type === 'context' || l.type === inBase) {
        const b = base[cur];
        if (b === undefined || stripCr(stripEol(b)) !== stripCr(l.text)) {
          throw kindError('stale', `hunk ${hi} does not match the file`);
        }
        if (b.endsWith('\r\n') && !l.text.endsWith('\r')) smudged = true;
        cur++;
        if (l.type === 'context' || !picked) res.push(b);
      } else if (l.type === other && picked) {
        inserted.push(res.length);
        res.push(l.noNewlineAtEof ? l.text : `${l.text}\n`);
      }
    });
  });
  while (cur < base.length) res.push(base[cur++]);
  if (smudged) {
    for (const i of inserted) {
      if (res[i].endsWith('\n') && !res[i].endsWith('\r\n')) res[i] = `${res[i].slice(0, -1)}\r\n`;
    }
  }
  // A kept "no newline at EOF" line that is no longer last needs a terminator: use the ending
  // of the adjacent line (previous, else next), or "\n".
  for (let i = 0; i < res.length - 1; i++) {
    if (res[i].endsWith('\n')) continue;
    res[i] += res[i].endsWith('\r') ? '\n' : (i > 0 && eolOf(res[i - 1])) || eolOf(res[i + 1]) || '\n';
  }
  return res.join('');
}

// ---------------------------------------------------------------------------
// Git-backed operations
//
// Commands run at the worktree root (exec), so `file` is always root-relative, whatever `cwd`.

const LITERAL = { env: LITERAL_ENV };

// Blob content as a latin1 byte string.
const blobText = (cwd, sha) => out(cwd, ['cat-file', 'blob', sha], { encoding: 'latin1' });

// The single parsed file of a one-path diff, or an empty stand-in when there is no diff. A type
// change (file <-> symlink) is two sections, a deletion and a new file: kind 'unsupported'.
function onlyFile(text) {
  const files = parsePatch(text, { encoding: 'latin1' });
  if (files.length > 1) {
    throw kindError('unsupported', 'The file type changed (e.g. file <-> symbolic link): stage or discard the whole file');
  }
  return files[0] || newFile('latin1');
}

// Line and hunk actions only make sense for regular files: a symlink's "content" is its target
// and a submodule's is a commit id (kinds 'symlink' / 'submodule').
function refuseSpecial(file, ...entries) {
  for (const e of entries) {
    if (e && e.mode === '120000') throw kindError('symlink', `${file} is a symbolic link: stage or discard the whole file`);
    if (e && e.mode === '160000') throw kindError('submodule', `${file} is a submodule: stage or discard the whole file`);
  }
}

/**
 * Index entry of `file` for a working-tree action (stage / discard), or null for an untracked
 * file. `file` must be spelled exactly like a tracked path or like a path `git ls-files --others`
 * lists: a case variant ('readme.md' on a case-insensitive disk), a non-canonical spelling
 * ('a/./b') or a path through a symlinked folder is neither, and throws kind 'stale' (the diff
 * would be empty or wrong, and a discard would delete the tracked file). Symlinks and submodules
 * throw kind 'symlink' / 'submodule' (see refuseSpecial).
 */
async function workdirEntry(root, file) {
  const idx = await indexEntry(root, file);
  if (idx) {
    refuseSpecial(file, idx);
    return idx;
  }
  if (!(await git.isUntracked(root, file))) throw kindError('stale', `${file} is not a changed file in this repository`);
  if (fs.lstatSync(path.join(root, file), { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw kindError('symlink', `${file} is a symbolic link: stage or discard the whole file`);
  }
  return null;
}

// The argument lists git.diffWorkdir shows (src/diff-args.js), so the displayed diff is the one
// indexed here by construction.
const runDiff = (cwd, { args, opts }) => out(cwd, args, opts);
const workdirPatch = (cwd, file, tracked) => runDiff(cwd, workdirDiff(file, { untracked: !tracked }));
const stagedPatch = (cwd, file) => runDiff(cwd, workdirDiff(file, { staged: true }));

// Index mode for an untracked regular file (symlinks are refused earlier, see workdirEntry).
function workdirMode(abs) {
  const st = fs.lstatSync(abs, { throwIfNoEntry: false });
  return st && st.mode & 0o111 ? '100755' : '100644';
}

// Store `content` (latin1 string) byte-exact (--no-filters, see stageSelection) and point the index at it.
async function writeIndex(cwd, file, mode, content) {
  const input = Buffer.from(content, 'latin1');
  const sha = (await out(cwd, ['hash-object', '-w', '--stdin', '--no-filters'], { input })).trim();
  await run(cwd, ['update-index', '--add', '--cacheinfo', `${mode},${sha},${file}`]);
  return sha;
}

// Refuse binary diffs, and diffs that differ from the one the UI displayed (opts.fingerprint).
// opts.checkPatch(raw, patch, selection), when given, may refuse more (it throws); ops.js uses
// it to refuse selections reaching into hunks the capped diff view did not show in full.
function checkPatch(raw, patch, selection, opts) {
  if (patch.isBinary) throw kindError('binary', 'cannot stage lines of a binary file');
  if (opts && opts.fingerprint != null && opts.fingerprint !== fingerprint(patch)) {
    throw kindError('stale', 'the file changed since its diff was shown');
  }
  if (opts && typeof opts.checkPatch === 'function') opts.checkPatch(raw, patch, selection);
}

/**
 * Stage the selected lines of the index->workdir diff of `file` (root-relative path).
 * Base and patch are both in git's "clean" form (diff runs clean filters on the workdir side),
 * so the result is already what belongs in the index; hashing it with filters (--path) would
 * convert it twice (e.g. re-cleaning an LFS pointer, or rewriting CRLF blobs). Hence --no-filters.
 * opts.fingerprint: fingerprint() of the diff the selection indexes; a mismatch throws 'stale'.
 * opts.checkPatch(raw, patch, selection): extra check run on the freshly computed diff (see checkPatch).
 * Refused, touching nothing: a path that is neither exactly tracked nor exactly untracked (kind
 * 'stale', see workdirEntry), a symlink or submodule ('symlink' / 'submodule'), a type change
 * ('unsupported'), a binary diff ('binary'), an unmerged path ('conflict').
 */
async function stageSelection(cwd, file, selection, opts = {}) {
  const root = await resolveRoot(cwd);
  const idx = await workdirEntry(root, file);
  const raw = await workdirPatch(root, file, !!idx);
  const patch = onlyFile(raw);
  checkPatch(raw, patch, selection, opts);
  const base = idx ? await blobText(root, idx.sha) : '';
  const next = applySelection(base, patch, selection);
  if (patch.isDeleted && next === '') {
    await run(root, ['update-index', '--force-remove', '--', file]);
    return;
  }
  await writeIndex(root, file, idx ? idx.mode : workdirMode(path.join(root, file)), next);
}

/**
 * Unstage the selected lines of the HEAD->index diff of `file` (HEAD is empty in an unborn repo).
 * If the result matches HEAD the entry is restored from HEAD; a new file whose staged content
 * becomes empty is removed from the index. opts.fingerprint as in stageSelection. Refuses a path
 * in neither the index nor HEAD ('stale') and symlinks / submodules / type changes as stageSelection.
 */
async function unstageSelection(cwd, file, selection, opts = {}) {
  const root = await resolveRoot(cwd);
  const idx = await indexEntry(root, file);
  const head = await headEntry(root, file);
  if (!idx && !head) throw kindError('stale', `${file} is not a staged file in this repository`);
  refuseSpecial(file, idx, head);
  const raw = await stagedPatch(root, file);
  const patch = onlyFile(raw);
  checkPatch(raw, patch, selection, opts);
  const indexText = idx ? await blobText(root, idx.sha) : '';
  const next = applySelection(indexText, patch, selection, { reverse: true });
  if (head) {
    const headText = await blobText(root, head.sha);
    if (next === headText && (!idx || idx.mode === head.mode)) {
      await run(root, ['restore', '--staged', '--', file], LITERAL);
      return;
    }
  } else if (next === '') {
    await run(root, ['update-index', '--force-remove', '--', file]);
    return;
  }
  await writeIndex(root, file, idx ? idx.mode : head.mode, next);
}

/** Test-only hooks. beforeWrite(abs): called after the first guard check, before the final one. */
const testHooks = { beforeWrite: null };

/**
 * Discard the selected lines of the index->workdir diff by rewriting the working file.
 * An untracked file whose every line is discarded is deleted. File mode is kept.
 * The caller is responsible for the undo backup (undo.withDiscardBackup). opts.fingerprint, and the paths,
 * symlinks, submodules and type changes it refuses, as in stageSelection.
 * Refuses (touching nothing) paths through any symbolic link, kind 'symlink', and paths outside
 * the worktree or inside the git dir, kind 'outside' (see worktreeGuard). The guard runs again
 * right before the write, and the write itself never follows a final symlink (O_NOFOLLOW).
 */
async function discardSelection(cwd, file, selection, opts = {}) {
  const root = await resolveRoot(cwd);
  const idx = await workdirEntry(root, file);
  const raw = await workdirPatch(root, file, !!idx);
  const patch = onlyFile(raw);
  checkPatch(raw, patch, selection, opts);
  const guard = await worktreeGuard(root);
  const abs = guard.check(file);
  const buf = readNoFollow(abs);
  if (buf && buf.includes(0)) throw kindError('binary', 'cannot discard lines of a binary file');
  const next = Buffer.from(applySelection(buf ? buf.toString('latin1') : '', patch, selection, { reverse: true }), 'latin1');
  if (testHooks.beforeWrite) testHooks.beforeWrite(abs); // tests: simulate a change between guard and write
  guard.check(file); // re-check right before touching the file (narrows the race window)
  if (!idx && buf && buf.length && !next.length) {
    fs.unlinkSync(abs); // removes a link itself, never its target; parents were just checked
  } else if (buf) {
    writeNoFollow(abs, next); // existing file keeps its mode
  } else {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    guard.check(file); // mkdir may have raced with a swapped-in parent link
    writeNoFollow(abs, next, { create: true, mode: idx && idx.mode === '100755' ? 0o755 : 0o644 });
  }
}

module.exports = {
  parsePatch, applySelection, fingerprint, decodeForDisplay,
  stageSelection, unstageSelection, discardSelection,
  testHooks,
  // src/worktree-fs.js, re-exported for existing callers (tests).
  worktreeGuard, readNoFollow, writeNoFollow,
};
