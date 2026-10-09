'use strict';
// The stash list and our autostash re-apply (split out of git.js, which re-exports it). Stash
// entries are always handled by their commit hash, never by a position that may shift. Built on
// the working tree's own state (src/working-state.js): nothing here knows about rebases or merges.
const fs = require('node:fs');
const path = require('node:path');
const { kindError, tagError, run, out, cleanFiles } = require('./exec');
const { resolveRoot } = require('./repo-dirs');
const { OID } = require('./gitref');
const { v2Records } = require('./porcelain');
const gitErrors = require('./git-errors');
const { verify } = require('./git-reads');
const { workingState, hasChanges } = require('./working-state');
const { AUTOSTASH_MSG } = require('./namespace');


/** Every stash entry, newest first: [{index, ref, hash, parents, date, message}]. */
async function stashes(cwd) {
  if (!(await verify(cwd, 'refs/stash'))) return [];
  const raw = await out(cwd, ['rev-list', '--walk-reflogs', '--no-commit-header', '--format=%H%x00%P%x00%ct%x00%s%x00', 'refs/stash']);
  return raw.split('\0\n').filter((r) => r.trim()).map((r, index) => {
    const [hash, parents, date, message] = r.replace(/^\n/, '').split('\0');
    return { index, ref: `stash@{${index}}`, hash, parents: parents ? parents.split(' ') : [], date: Number(date), message };
  });
}

/** Current index of the stash entry with commit `hash`, or null when it is gone. */
async function stashIndexOf(cwd, hash) {
  const entry = (await stashes(cwd)).find((s) => s.hash === hash);
  return entry ? entry.index : null;
}

/** Commit hash of stash `index` (number) — or `hash` itself, checked to be a stash entry. */
async function resolveStash(cwd, ref) {
  if (typeof ref === 'string' && OID.test(ref)) {
    if ((await stashIndexOf(cwd, ref)) === null) throw kindError('no-stash', `No stash entry ${ref}`);
    return ref;
  }
  const n = Number(ref);
  if (!Number.isInteger(n) || n < 0) throw kindError('invalid-args', `Invalid stash reference: ${ref}`);
  const hash = await verify(cwd, `refs/stash@{${n}}`);
  if (!hash) throw kindError('no-stash', `No stash entry stash@{${n}}`);
  return hash;
}

/**
 * Apply the stash commit `hash`, restoring the staged/unstaged split (`--index`). If only the
 * index can't be restored, fall back to a plain apply and report `indexRestored: false`.
 * Conflicts throw kind 'conflicts' (markers stay in the tree), with `indexRestored`.
 */
async function applyStashHash(cwd, hash) {
  const conflicts = async (err, indexRestored) => {
    const st = await workingState(cwd).catch(() => null);
    if (st && st.conflicted.length) throw tagError(err, 'conflicts', { indexRestored });
    throw Object.assign(err, { indexRestored });
  };
  try {
    await run(cwd, ['stash', 'apply', '-q', '--index', hash]);
    return { indexRestored: true };
  } catch (err) {
    if (!gitErrors.unclassified(err) || !gitErrors.matches(err, 'applyWithoutIndex')) return conflicts(err, true);
  }
  try {
    await run(cwd, ['stash', 'apply', '-q', hash]);
    return { indexRestored: false };
  } catch (err) {
    return conflicts(err, false);
  }
}

/** Drop the entry whose commit is `hash`, wherever it now is in the list. False when gone. */
async function stashDropHash(cwd, hash) {
  const index = await stashIndexOf(cwd, hash);
  if (index === null) return false;
  await run(cwd, ['stash', 'drop', '-q', `stash@{${index}}`]);
  return true;
}

/** Returns the new stash's hash, or null when there was nothing to stash. */
async function stashPush(cwd, message) {
  const before = await verify(cwd, 'refs/stash');
  await run(cwd, ['stash', 'push', '--include-untracked', ...(message ? ['-m', message] : [])]);
  const after = await verify(cwd, 'refs/stash');
  return after && after !== before ? after : null;
}

/** Apply stash `ref` (index, or entry hash); see applyStashHash. Returns { hash, indexRestored }. */
async function stashApply(cwd, ref) {
  const hash = await resolveStash(cwd, ref);
  return { hash, ...(await applyStashHash(cwd, hash)) };
}

/** Drop a stash entry; resolves false when it vanished meanwhile (kind 'no-stash' when already gone). */
async function stashDrop(cwd, ref) {
  return stashDropHash(cwd, await resolveStash(cwd, ref));
}

/**
 * Apply then drop, so a failed or conflicting apply never loses the stash. The entry is
 * resolved to its hash first and dropped by hash, so a stash pushed meanwhile is never dropped.
 * Returns { hash, indexRestored, dropped }.
 */
async function stashPop(cwd, ref) {
  const res = await stashApply(cwd, ref);
  return { ...res, dropped: await stashDropHash(cwd, res.hash) };
}

/**
 * Paths with changes to tracked files: staged or unstaged (`unstagedOnly`: unstaged only), and
 * conflicted ones. Untracked files never count, and neither do submodules (a commit or content
 * change inside one): `stash push` leaves them alone and the reset that undoes a failed re-apply
 * doesn't recurse into them, so they never stand in the way of a re-apply.
 */
async function trackedChanges(cwd, { unstagedOnly = false } = {}) {
  const raw = await out(cwd, ['status', '--porcelain=v2', '-z', '--untracked-files=no', '--ignore-submodules=all']);
  return v2Records(raw)
    .filter((r) => r.type === 'u' || ((r.type === '1' || r.type === '2') && (!unstagedOnly || r.xy[1] !== '.')))
    .map((r) => r.path);
}

/** The untracked files stash `sha` holds (its third parent's tree, `stash push -u`); [] without. */
async function stashUntracked(cwd, sha) {
  if (!(await verify(cwd, `${sha}^3`))) return [];
  return (await out(cwd, ['ls-tree', '-r', '-z', '--full-tree', '--name-only', `${sha}^3`])).split('\0').filter(Boolean);
}

/** True when some of `paths` (root-relative) exists in the worktree, or can't be created (a file where a folder must be). */
async function anyInTheWay(cwd, paths) {
  if (!paths.length) return false;
  const root = await resolveRoot(cwd);
  return paths.some((p) => {
    try {
      return !!fs.lstatSync(path.join(root, p), { throwIfNoEntry: false });
    } catch {
      return true; // ENOTDIR: a parent is a file
    }
  });
}

/** Paths whose index or worktree stash `sha` changes (vs the commit it was made on). */
async function stashTouches(cwd, sha) {
  const names = async (a, b) => (await out(cwd, ['diff-tree', '-r', '-z', '--no-renames', '--name-only', a, b])).split('\0').filter(Boolean);
  return new Set([...(await names(`${sha}^1`, sha)), ...(await names(`${sha}^1`, `${sha}^2`))]);
}

/**
 * Undo a failed apply of stash `sha`: `reset --hard HEAD` (not into submodules), then remove the
 * stash's untracked files that the apply created (`untracked`: none of them existed before, see
 * reapplyStash). The window between reapplyStash's dirty check and this reset is narrowed by a
 * second check: a tracked file changed outside the paths the stash touches means someone else
 * wrote to the tree meanwhile, and the reset is not run (it throws, so the caller reports
 * resetFailed: the stash still has everything).
 */
async function undoApply(cwd, sha, untracked) {
  const touched = await stashTouches(cwd, sha);
  if ((await trackedChanges(cwd)).some((p) => !touched.has(p))) {
    throw kindError('dirty', 'The working tree changed while the stash was being re-applied, so it was not reset');
  }
  await run(cwd, ['reset', '-q', '--hard', '--no-recurse-submodules', 'HEAD']);
  await cleanFiles(cwd, untracked);
}

/**
 * Re-apply the stash `sha` (applyStashHash: by hash, with the staged/unstaged split) and drop it.
 * Only onto a tree without changes to tracked files: with any (staged or not) nothing is applied
 * and the stash is kept (reason 'dirty'), since the `reset --hard HEAD` that undoes a failed
 * apply would take them along. Nothing is applied either when one of the stash's untracked
 * files is in the way (reason 'untracked': git would restore the others and then give up). A
 * failed apply (reason 'conflict', or 'index' when git gave up without conflicts) is undone
 * (undoApply) and the stash kept. Not cancellable by itself: callers run it under no signal.
 * @returns {Promise<{restored: boolean, indexRestored?: boolean, gone?: true,
 *   stash?: {kept: true, sha, reason: 'dirty'|'untracked'|'conflict'|'index'}, resetFailed?: true,
 *   resetError?: Error, error?: Error, dropError?: Error}>}
 *   gone: the stash isn't in the stash list (nothing done); error: the failed apply's error;
 *   dropError: applied, but dropping the stash failed (it is still in the list).
 */
async function reapplyStash(cwd, sha) {
  const kept = (reason) => ({ restored: false, stash: { kept: true, sha, reason } });
  if ((await stashIndexOf(cwd, sha)) === null) return { restored: false, gone: true };
  if ((await trackedChanges(cwd)).length) return kept('dirty');
  const untracked = await stashUntracked(cwd, sha);
  if (await anyInTheWay(cwd, untracked)) return kept('untracked');
  let applied;
  try {
    applied = await applyStashHash(cwd, sha);
  } catch (error) {
    const res = { ...kept(error.kind === 'conflicts' ? 'conflict' : 'index'), error };
    await undoApply(cwd, sha, untracked).catch((resetError) => Object.assign(res, { resetFailed: true, resetError }));
    return res;
  }
  const res = { restored: true, indexRestored: applied.indexRestored };
  await stashDropHash(cwd, sha).catch((dropError) => Object.assign(res, { dropError }));
  return res;
}

/**
 * Why re-applying local changes kept them in the stash, by reapplyStash's `reason`: the end of
 * a sentence about "your local changes". The one table withAutostash and our persistent
 * autostash (src/autostash.js, Pull's rebase) word these with.
 */
const KEPT_WHY = Object.freeze({
  dirty: 'the working tree had changed again when they were to be re-applied',
  untracked: 'some of their untracked files are in the way in the working tree',
  index: 'git could not apply them',
  conflict: 'they conflicted with the commits they were re-applied onto',
});

/**
 * Run fn with a clean working tree. Local changes are stashed and re-applied (reapplyStash)
 * afterwards.
 * - fn throws and the repo is left mid-merge/rebase/with conflicts: the stash is kept and
 *   err.stashKept = true, err.stash = hash (re-applying on top of conflicts would be a mess).
 * - Re-applying fails (conflicts): `reset --hard HEAD` (everything lost is in the stash), keep
 *   the stash and throw kind 'stash-conflict' with stashKept, stash (hash), reason ('conflict' |
 *   'index') and result (fn's return value, since fn itself succeeded). If the reset fails too,
 *   err.resetFailed = true and err.resetError is set; stashKept/stash are always present. A tree
 *   that has changes to tracked files again by then is left alone (reason 'dirty'), and so is a
 *   stash whose untracked files are in the way (reason 'untracked').
 * - On success returns fn's value; if the index could not be restored the tree has the changes
 *   but all unstaged — reported via the optional `onReapply({ indexRestored })` callback.
 */
async function withAutostash(cwd, fn, { onReapply } = {}) {
  if (!hasChanges(await workingState(cwd))) return fn();
  const stash = await stashPush(cwd, AUTOSTASH_MSG);
  if (!stash) return fn();
  const kept = { stashKept: true, stash };

  const reapply = async () => {
    const res = await reapplyStash(cwd, stash);
    if (res.gone) return; // someone dropped it already
    if (res.dropError) throw Object.assign(res.dropError, kept);
    if (!res.restored) {
      const { reason } = res.stash;
      const err = res.error
        ? tagError(res.error, 'stash-conflict', { ...kept, reason })
        : kindError('stash-conflict', `Your local changes are kept in the stash: ${KEPT_WHY[reason]}`, { ...kept, reason });
      throw res.resetFailed ? Object.assign(err, { resetFailed: true, resetError: res.resetError }) : err;
    }
    if (onReapply) onReapply({ indexRestored: res.indexRestored });
  };

  const result = await Promise.resolve().then(fn).catch(async (err) => {
    const after = await workingState(cwd).catch(() => null);
    if (!after || after.state !== 'clean' || after.conflicted.length) throw Object.assign(err, kept);
    await reapply().catch((reapplyError) => Object.assign(err, kept, { reapplyError }));
    throw err;
  });
  await reapply().catch((err) => {
    throw Object.assign(err, { result });
  });
  return result;
}

module.exports = {
  AUTOSTASH_MSG, KEPT_WHY, stashes, stashIndexOf, stashPush, stashApply, stashDrop, stashPop, trackedChanges,
  reapplyStash, withAutostash,
};
