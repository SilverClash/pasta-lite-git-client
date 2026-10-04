'use strict';
// Parsers for git's machine-readable output (NUL-separated records, `status --porcelain=v2 -z`,
// `ls-files -s / -u -z`, `worktree list --porcelain -z`, `--name-status -z`). Pure: they take the
// text a command printed and never run git, so every module parses a format the same way.
const { OID, isZero, branchOf } = require('./gitref');

/** Split `s` on `sep` into at most `n` parts (last part keeps the rest). */
function splitN(s, sep, n) {
  const parts = [];
  let i = 0;
  while (parts.length < n - 1) {
    const j = s.indexOf(sep, i);
    if (j < 0) break;
    parts.push(s.slice(i, j));
    i = j + 1;
  }
  parts.push(s.slice(i));
  return parts;
}

/**
 * Split NUL-separated output into records of `nFields` fields. A leading '\n' on a record's
 * first field (left by formats that end records with a newline) is removed.
 */
function parseNulRecords(raw, nFields) {
  const f = raw.split('\0');
  const records = [];
  for (let i = 0; i + nFields <= f.length; i += nFields) {
    const rec = f.slice(i, i + nFields);
    rec[0] = rec[0].replace(/^\n/, '');
    if (rec.length === 1 && rec[0] === '') continue;
    records.push(rec);
  }
  return records;
}

/**
 * `s` without its trailing newlines: what `replace(/\n+$/, '')` gives, in linear time (the regex
 * backtracks quadratically on a long run of newlines that isn't at the end).
 */
function trimTrailingNewlines(s) {
  let end = s.length;
  while (end > 0 && s[end - 1] === '\n') end--;
  return s.slice(0, end);
}

// ---------------------------------------------------------------- status --porcelain=v2 -z

/**
 * Space-separated fields of each changed-path record type (the path, last, may hold spaces):
 * 1 XY sub mH mI mW hH hI path | 2 XY sub mH mI mW hH hI Xscore path \0 orig
 * | u XY sub m1 m2 m3 mW h1 h2 h3 path
 */
const V2_FIELDS = Object.freeze({ 1: 9, 2: 10, u: 11 });

/**
 * The records of `status --porcelain=v2 -z` output: [{type: '1'|'2'|'u', xy, path, orig?}] for
 * changed paths (a type-2 rename or copy takes the next field as its source path `orig`),
 * {type: '#', key, value} for a `--branch` header, {type: '?'|'!', path} for untracked / ignored.
 */
function v2Records(raw) {
  const fields = raw.split('\0');
  const res = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (!f) continue;
    const type = f[0];
    if (Object.hasOwn(V2_FIELDS, type)) {
      const parts = splitN(f, ' ', V2_FIELDS[type]);
      const rec = { type, xy: parts[1], path: parts[parts.length - 1] };
      if (type === '2') rec.orig = fields[++i]; // the source path is the next field
      res.push(rec);
    } else if (type === '#') {
      const [, key, value] = splitN(f, ' ', 3);
      res.push({ type, key, value });
    } else if (type === '?' || type === '!') {
      res.push({ type, path: f.slice(2) });
    }
  }
  return res;
}

/** A status entry for one side (X or Y) of a changed path; a rename or copy carries its source. */
function statusEntry(path, code, orig) {
  return orig !== undefined && 'RC'.includes(code) ? { path, status: code, orig } : { path, status: code };
}

/** One `# branch.<key> <value>` header of `status --porcelain=v2 --branch` into `res`. */
function applyBranchHeader(res, key, value) {
  if (key === 'branch.oid') res.oid = value === '(initial)' ? null : value;
  else if (key === 'branch.head') res.branch = value === '(detached)' ? null : value;
  else if (key === 'branch.upstream') res.upstream = value;
  else if (key === 'branch.ab') {
    const m = /^\+(\d+) -(\d+)$/.exec(value);
    if (m) [res.ahead, res.behind] = [Number(m[1]), Number(m[2])];
  }
}

/**
 * The records of `status --porcelain=v2 --branch -z` into `res` (branch headers, staged /
 * unstaged / conflicted entries). `conflicted`: [{path, status: 'U', xy}]; an unstaged rename
 * (only with intent-to-add entries) carries its source like a staged one.
 */
function parsePorcelainV2(raw, res) {
  for (const r of v2Records(raw)) {
    if (r.type === '#') {
      applyBranchHeader(res, r.key, r.value);
    } else if (r.type === 'u') {
      res.conflicted.push({ path: r.path, status: 'U', xy: r.xy });
    } else if (r.type === '?') {
      res.unstaged.push({ path: r.path, status: '?' });
    } else if (r.type === '1' || r.type === '2') {
      if (r.xy[0] !== '.') res.staged.push(statusEntry(r.path, r.xy[0], r.orig));
      if (r.xy[1] !== '.') res.unstaged.push(statusEntry(r.path, r.xy[1], r.orig));
    }
  }
  return res;
}

// ---------------------------------------------------------------- other formats

/**
 * Index entries of `ls-files -s -z` / `ls-files -u -z` (`<mode> SP <object> SP <stage> TAB
 * <path>`): [{mode, sha, stage, path}], stage 0 for a merged entry, 1–3 for the sides of a
 * conflict. Records that aren't one are skipped.
 */
function parseStageEntries(raw) {
  const res = [];
  for (const rec of raw.split('\0')) {
    const m = /^(\d{6}) ([0-9a-f]+) ([0-3])\t(.*)$/s.exec(rec);
    if (m) res.push({ mode: m[1], sha: m[2], stage: Number(m[3]), path: m[4] });
  }
  return res;
}

/**
 * `git worktree list --porcelain -z`, main one first: [{path, head, branch, bare, detached,
 * locked, lockReason, prunable, prunableReason}]. `path` as git prints it; `head` the checked-out
 * commit (null for the bare entry or an unborn branch); `branch` the short name (null when
 * detached or bare); locked / prunable: booleans, with git's reason as the text after the key
 * (lockReason / prunableReason; null when git gives none). Unknown keys are ignored.
 */
function parseWorktrees(raw) {
  const list = [];
  let cur = null;
  for (const f of raw.split('\0')) {
    if (f === '') { // a record ends with an empty field
      if (cur) list.push(cur);
      cur = null;
      continue;
    }
    const [key, value = ''] = splitN(f, ' ', 2);
    if (key === 'worktree') {
      if (cur) list.push(cur);
      cur = {
        path: value, head: null, branch: null, bare: false, detached: false,
        locked: false, lockReason: null, prunable: false, prunableReason: null,
      };
    } else if (!cur) {
      continue;
    } else if (key === 'HEAD') {
      cur.head = OID.test(value) && !isZero(value) ? value : null;
    } else if (key === 'branch') {
      cur.branch = branchOf(value) ?? value;
    } else if (key === 'bare' || key === 'detached') {
      cur[key] = true;
    } else if (key === 'locked') {
      cur.locked = true;
      cur.lockReason = value || null;
    } else if (key === 'prunable') {
      cur.prunable = true;
      cur.prunableReason = value || null;
    }
  }
  if (cur) list.push(cur);
  return list;
}

/** `diff --name-status -z`: [{status, path, orig?}] (a rename or copy has its source as `orig`). */
function parseNameStatus(raw) {
  const f = raw.split('\0');
  const files = [];
  for (let i = 0; i < f.length; i++) {
    if (!f[i]) continue;
    const status = f[i][0];
    if (status === 'R' || status === 'C') {
      files.push({ status, orig: f[i + 1], path: f[i + 2] });
      i += 2;
    } else {
      files.push({ status, path: f[++i] });
    }
  }
  return files;
}

module.exports = {
  splitN, parseNulRecords, trimTrailingNewlines,
  V2_FIELDS, v2Records, parsePorcelainV2, parseStageEntries, parseWorktrees, parseNameStatus,
};
