'use strict';
// What of an error may cross the IPC boundary or reach the log: serializeError (the plain object
// main.js replies with; ops.serializeError re-exports it), the EXTRA_FIELDS it carries, logError
// (what an op's log record keeps) and the one kindOf every caller reads err.kind through.
const { GitError } = require('./exec');

/** err.kind when it is a string, else null. */
const kindOf = (err) => (err && typeof err.kind === 'string' ? err.kind : null);

/**
 * What a swallowed error was, for a log record: its kind, else 'git' (a GitError), its code or
 * 'error'. Never its message (git's text may name paths).
 */
const logKind = (err) => kindOf(err) || (err instanceof GitError ? 'git' : (err && err.code) || 'error');

// Extra error fields the UI needs (see git.js / undo.js); copied only when present.
const EXTRA_FIELDS = [
  'stashKept', 'stash', 'indexRestored', 'remotes', 'remoteMessage', 'reason', 'refspec',
  'blocked', 'state', 'tagConflicts', 'resetFailed', 'backup',
  // rebase / merge (docs/plans/rebase.md §4.5): `rebase` is the RebaseState a failed or cancelled
  // op left behind; `paths` / `count` of a 'dirty' or 'conflicts' refusal.
  'count', 'stop', 'rebase', 'dropped', 'skippedCherryPicks', 'hookOutput', 'published', 'paths',
  // R2: `merge` (status.merge a cancelled merge left), `refs` (the candidates of an 'ambiguous'
  // target), `head` (HEAD's sha of a 'stale' refusal).
  'merge', 'refs', 'head',
  // R3: `plan` (the rebasePlan of an interactive refusal such as 'merge-commits').
  'plan',
  // Linked worktrees: `submodules` of a 'worktree-dirty' remove (`reason`, above, is a
  // 'worktree-locked' one's lock reason, `state` a 'worktree-busy' one's stopped operation).
  'submodules',
];
// Nested errors, sent as their message string only.
const NESTED_ERRORS = ['resetError', 'reapplyError'];

const plain = (v) => {
  try {
    return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  } catch {
    return undefined;
  }
};

/** Strings, finite numbers, booleans, null and arrays / plain objects of those (bounded depth). */
function isPlainData(v, depth = 0) {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (v === undefined) return depth > 0; // dropped by JSON inside objects
  if (typeof v !== 'object' || depth > 8) return false;
  if (Array.isArray(v)) return v.every((x) => isPlainData(x, depth + 1));
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.values(v).every((x) => isPlainData(x, depth + 1));
}

/**
 * Plain, IPC-safe error: {message, kind, exitCode, ...extras, result?, resetError?, reapplyError?}.
 * `message` is err.message, which for a GitError IS git's stderr text (trimmed) — shown to the
 * user. Never included: stack, args, env, the raw stderr/stdout fields. `result` (the value of
 * an op that succeeded before a later step failed, e.g. a pull whose autostash re-apply
 * conflicted) is copied only when it is plain JSON data.
 */
function serializeError(err) {
  if (!err || typeof err !== 'object') return { message: String(err), kind: null, exitCode: null };
  const res = {
    message: typeof err.message === 'string' && err.message ? err.message : String(err),
    kind: kindOf(err),
    exitCode: Number.isInteger(err.exitCode) ? err.exitCode : null,
  };
  for (const k of EXTRA_FIELDS) {
    const v = plain(err[k]);
    if (v !== undefined && v !== null) res[k] = v;
  }
  if (err.result !== undefined && isPlainData(err.result)) res.result = plain(err.result);
  for (const k of NESTED_ERRORS) {
    const e = err[k];
    if (e) res[k] = typeof e.message === 'string' && e.message ? e.message : String(e);
  }
  return res;
}

/**
 * The part of an op's error the log may keep. git's text (a GitError) and our classified errors
 * (a `kind`) may name paths, refs or commit subjects ("Could not apply <sha>... <subject>", a
 * refusal listing the dirty files): only {name, kind, code, exitCode} of those. Anything else is
 * a bug (a TypeError...), logged whole (redacted).
 */
function logError(err) {
  if (!err || typeof err !== 'object' || (!(err instanceof GitError) && !kindOf(err))) return err;
  const res = { name: err.name };
  if (kindOf(err)) res.kind = kindOf(err);
  if (err.code !== undefined) res.code = err.code;
  if (Number.isInteger(err.exitCode)) res.exitCode = err.exitCode;
  return res;
}

module.exports = { kindOf, logKind, EXTRA_FIELDS, NESTED_ERRORS, isPlainData, serializeError, logError };

