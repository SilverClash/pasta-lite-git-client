'use strict';
// The op runner: write ops for one repo run one at a time (reads don't queue), 'busy'
// / 'changed' events for the watcher, cancellation by op id, one log record per op. Every op runs
// inside exec.withSignal, so cancelling kills whatever git process (and hook) it is running.
// It knows no op by name: ops.createRunner gives it the registry and the bare-repo gate.
const { EventEmitter } = require('node:events');
const exec = require('./exec');
const { invalid } = require('./op-validators');
const { kindOf, logError } = require('./ipc-errors');
const { logger } = require('./log');

const { kindError } = exec;

const abortedError = () => kindError('aborted', 'Operation was cancelled');

/**
 * @param {{ops: object, writeOps: Set<string>, gate?: (repo, name, args) => Promise<Error|null>,
 *   vet?: (repo, name, checked, info) => Promise<Error|null>, log?: object, now?: () => number}} o
 *   the registry (name -> op), the names of the writes, the refusal asked before anything runs
 *   (bare-gate.js; ops.createRunner passes the registry's), the refusal asked of every op just
 *   before it starts, once its check passed, with its checked arguments (null for an op without
 *   a check) and info {write, settled: a promise that resolves when the op settles, whatever the
 *   outcome} (ops.createRunner: a write running in the folder an op is about to delete, or a
 *   write in a folder being deleted), a logger (src/log.js child) that gets one record per op
 *   (default: the shared logger's 'ops' scope) and the clock (tests).
 * Returns an EventEmitter with run(repo, op, args, {opId}), cancel(opId), and for quitting
 * running(), cancelAll() and settled() (see there). Events (writes only,
 * and only for a write that passed validation and actually started):
 *   'busy'    {repo, op, running: true} when it starts; {..., running: false, ok} when it ends
 *   'changed' {repo, op, ok} when it ends, success or not (a failed write may still have changed
 *             the repo: conflicts, kept autostash, partial discard...)
 * Any op (read or write) run with an opId can be cancelled while queued or running: its git
 * processes and their hooks are killed and it rejects with kind 'aborted'.
 */
function createRunner({
  ops, writeOps, gate = async () => null, vet = async () => null, log = logger.child('ops'), now = Date.now,
} = {}) {
  const events = new EventEmitter();
  const queues = new Map(); // repo -> tail promise of its write queue
  const controllers = new Map(); // opId -> AbortController, while the op is queued or running
  const active = new Set(); // every validated-by-name op until it settles: {repo, op, write, owner, ctrl, started, done}

  /** Validate, then run `name` with every git command it spawns bound to `signal`. */
  // Ops built with op() get the runner's signal as act's last argument (the renderer's args never
  // reach act unchecked); plain ops just run under it (exec.withSignal). Every op is vetted after
  // its check (`vet`), still before onStart: a refusal emits no events either.
  // Bare repositories (bareGate): an op that needs a working tree (for these args), or
  // a fetch into a mirror, is refused first, before validation and before onStart, so it changes
  // nothing and a write emits no busy / changed events. Here rather than before the queue: a write
  // is enqueued synchronously, so writes keep their call order. repo-dirs.isBare is cached, so a normal
  // repo pays nothing.
  function invoke(repo, name, args, signal, onStart, entry) {
    const fn = ops[name];
    return exec.withSignal(signal, async () => {
      const refused = await gate(repo, name, args);
      if (refused) throw refused;
      let checked = null;
      if (typeof fn.check === 'function' && typeof fn.act === 'function') {
        try {
          checked = await fn.check(repo, ...args);
        } catch (err) {
          throw signal.aborted ? abortedError() : err;
        }
      }
      const vetoed = await vet(repo, name, checked, { write: entry.write, settled: entry.done });
      if (vetoed) throw vetoed;
      const act = checked ? () => fn.act(repo, ...checked, signal) : () => fn(repo, ...args);
      if (signal.aborted) throw abortedError();
      if (onStart) onStart();
      try {
        return await act();
      } catch (err) {
        if (signal.aborted && err && typeof err === 'object' && !err.kind) {
          try { err.kind = 'aborted'; } catch { /* frozen */ }
        }
        throw err;
      }
    });
  }

  async function runWrite(repo, name, args, signal, entry) {
    if (signal.aborted) throw abortedError(); // cancelled while queued: never started, no events
    let started = false;
    let ok = false;
    try {
      const value = await invoke(repo, name, args, signal, () => {
        started = true;
        entry.started = true;
        events.emit('busy', { repo, op: name, running: true });
      }, entry);
      ok = true;
      return value;
    } finally {
      if (started) {
        events.emit('busy', { repo, op: name, running: false, ok });
        events.emit('changed', { repo, op: name, ok });
      }
    }
  }

  function enqueue(repo, task) {
    const prev = queues.get(repo) || Promise.resolve();
    const p = prev.then(task);
    const tail = p.catch(() => {});
    queues.set(repo, tail);
    tail.then(() => { if (queues.get(repo) === tail) queues.delete(repo); });
    return p;
  }

  /**
   * One record per op once it settles: {op, repo, write, ms, outcome, kind?, cancelled, err?}.
   * Never the args (commit messages, paths). Successful reads are debug, writes info; a
   * cancelled op (kind 'aborted') is info; any other failure warn, with the error (logError).
   */
  function record(repo, name, t0, write, cancelled, err) {
    const base = { op: String(name).slice(0, 64), repo, write, ms: now() - t0, cancelled };
    if (!err) {
      log.log(write ? 'info' : 'debug', 'op done', { ...base, outcome: 'ok' });
      return;
    }
    const kind = kindOf(err);
    const aborted = kind === 'aborted';
    log.log(aborted ? 'info' : 'warn', aborted ? 'op cancelled' : 'op failed', { ...base, outcome: aborted ? 'cancelled' : 'error', kind, err: logError(err) });
  }

  /**
   * Run `name` for `repo`; args is the renderer's argument array (repo is never part of it).
   * `owner` (main: the tab that asked) only tags the op for running() / cancelAll / settled.
   */
  async function run(repo, name, args = [], { opId, owner = null } = {}) {
    const t0 = now();
    const state = { write: writeOps.has(name), ctrl: null };
    try {
      const value = await runOp(repo, name, args, opId, owner, state);
      record(repo, name, t0, state.write, !!(state.ctrl && state.ctrl.signal.aborted), null);
      return value;
    } catch (err) {
      record(repo, name, t0, state.write, !!(state.ctrl && state.ctrl.signal.aborted), err);
      throw err;
    }
  }

  async function runOp(repo, name, args, opId, owner, state) {
    if (typeof name !== 'string' || !Object.hasOwn(ops, name)) throw kindError('unknown-op', `Unknown operation: ${name}`);
    if (!Array.isArray(args)) throw invalid('args must be an array');
    if (opId !== undefined && opId !== null && (typeof opId !== 'string' || !opId)) throw invalid('opId must be a string');
    if (opId && controllers.has(opId)) throw invalid(`operation id already in use: ${opId}`);
    const ctrl = new AbortController();
    state.ctrl = ctrl;
    if (opId) controllers.set(opId, ctrl);
    const write = writeOps.has(name);
    let settle;
    const entry = { repo, op: name, write, owner, ctrl, started: !write, done: new Promise((r) => { settle = r; }) };
    active.add(entry);
    const p = write ? enqueue(repo, () => runWrite(repo, name, args, ctrl.signal, entry)) : invoke(repo, name, args, ctrl.signal, null, entry);
    p.then(settle, settle);
    try {
      return await p;
    } finally {
      active.delete(entry);
      if (opId) controllers.delete(opId);
    }
  }

  /** Abort a queued or running op. True only when such an op was found (and not already cancelled). */
  function cancel(opId) {
    const ctrl = controllers.get(opId);
    if (!ctrl || ctrl.signal.aborted) return false;
    ctrl.abort();
    return true;
  }

  // `{owner}` given: only the ops run with that owner (one tab's), else every op.
  const mine = ({ owner } = {}) => [...active].filter((e) => owner === undefined || e.owner === owner);

  /**
   * Every op not settled yet (with or without an opId), in call order: [{repo, op, write, owner,
   * started, cancelled}]. `started`: false for a write still waiting in its repo's queue.
   * `cancelled`: its signal was aborted; it may still be running (a phase that can't be cut short).
   */
  const running = (o) => mine(o).map((e) => ({
    repo: e.repo, op: e.op, write: e.write, owner: e.owner, started: e.started, cancelled: e.ctrl.signal.aborted,
  }));

  /** Cancel every queued and running op, as cancel(opId) does; returns how many were cancelled. */
  function cancelAll(o) {
    let n = 0;
    for (const e of mine(o)) {
      if (e.ctrl.signal.aborted) continue;
      e.ctrl.abort();
      n++;
    }
    return n;
  }

  /** Resolves once no op is left (including ones started meanwhile); never rejects. */
  async function settled(o) {
    for (let left = mine(o); left.length; left = mine(o)) await Promise.all(left.map((e) => e.done));
  }

  return Object.assign(events, { run, cancel, running, cancelAll, settled });
}

module.exports = { createRunner };
