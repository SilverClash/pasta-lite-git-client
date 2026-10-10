'use strict';
// What quitting does while git operations are running. Pure: the
// runner, the process killer, the dialogs and the clock are passed in, so tests use fakes.
//
// git is spawned detached (exec.js), so an op that is still running when the app exits keeps
// going on its own: a push completed 20 s after the app had quit. The policy:
// - no write queued or running: quit at once (a running read is just cancelled);
// - otherwise ask "Cancel and Quit" / "Keep Running" (smoke mode: never asks, cancels and logs);
// - Cancel and Quit: cancel every op through the runner, wait for them to settle (at most
//   `boundMs`), SIGKILL any git process that outlived its cancel, then quit;
// - an op that can't be cancelled (undo's reversal, a discard's backup record: they run under no
//   or a non-aborted signal) is left to finish within the bound. If it outlives it, ask again,
//   "Quit" / "Wait": quitting now could leave the worktree half-restored.
//
// Tabs: the runner is shared by every tab, so running() / cancelAll() above already
// cover the writes of all tabs. Closing one tab is createCloseGuard below, over the ops of that
// tab only (main passes a runner view scoped to the tab's owner id).

const BOUND_MS = 5000; // how long cancelled ops get to settle
const GRACE_MS = 500; // after a kill, for the ops to notice their git is gone

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** The questions the guards ask (confirm(kind, names), dialogOptions(kind, names)). */
const DIALOG_KINDS = Object.freeze({
  RUNNING: 'running', // quitting while a write runs: Cancel and Quit / Keep Running
  UNSAFE: 'unsafe', // an uncancellable op outlived the bound: Quit / Wait
  CLOSE: 'close', // closing a tab while its write runs: Cancel and Close / Keep Running
});

/** Distinct op names of `list` (runner.running() rows), in order: "push, fetch". */
const opNames = (list) => [...new Set(list.map((r) => r.op))].join(', ');

/**
 * @param {{
 *   runner: {running(): {op, write, started, cancelled}[], cancelAll(): number, settled(): Promise<void>},
 *   killChildren: (o: {all?: boolean, signal?: string}) => number,
 *   confirm: (kind: 'running'|'unsafe', names: string) => Promise<boolean>,
 *   log?: (msg: string) => void, smoke?: boolean, boundMs?: number, graceMs?: number,
 *   wait?: (ms: number) => Promise<void>,
 * }} o  confirm('running') true = Cancel and Quit; confirm('unsafe') true = Quit (false = Wait).
 * @returns {{needsConfirm(): boolean, quitNow(): void, run(): Promise<'quit'|'stay'>}}
 *   needsConfirm: synchronous, for before-quit: false means quit right away, after quitNow()
 *   (cancels running reads).
 *   run: the whole decision; 'quit' when the app may exit now (nothing of ours still runs,
 *   unless the user chose to quit anyway), 'stay' when the user kept the op running.
 */
function createQuitGuard({
  runner, killChildren, confirm, log = () => {}, smoke = false,
  boundMs = BOUND_MS, graceMs = GRACE_MS, wait = delay,
}) {
  const writes = () => runner.running().filter((r) => r.write);
  /** runner.settled(), or false after `ms`. */
  const settledWithin = (ms) => Promise.race([runner.settled().then(() => true), wait(ms).then(() => false)]);

  /** Nothing worth asking about: cancel whatever reads are running and quit. */
  function quitNow() {
    runner.cancelAll();
  }

  async function run() {
    const busy = writes();
    if (!busy.length) {
      quitNow();
      return 'quit';
    }
    const names = opNames(busy);
    if (smoke) log(`quitting: cancelling running git operations (${names})`);
    else if (!(await confirm(DIALOG_KINDS.RUNNING, names))) return 'stay';

    runner.cancelAll();
    const cancelled = () => {
      log(`quitting: cancelled ${names}`);
      return 'quit';
    };
    if (await settledWithin(boundMs)) return cancelled();
    // A cancelled git that is still alive ignored SIGTERM: kill it. Uncancellable phases keep theirs.
    if (killChildren({ signal: 'SIGKILL' }) && await settledWithin(graceMs)) return cancelled();

    for (;;) {
      const left = runner.running();
      if (!left.length) return 'quit';
      // Writes queued behind the one still running settle (skipped) right after it: name that one.
      const unsafe = opNames(left.some((r) => r.started) ? left.filter((r) => r.started) : left);
      if (smoke) log(`quitting: ${unsafe} did not finish within ${boundMs} ms; quitting anyway`);
      if (smoke || await confirm(DIALOG_KINDS.UNSAFE, unsafe)) {
        killChildren({ all: true, signal: 'SIGTERM' });
        if (!(await settledWithin(graceMs))) killChildren({ all: true, signal: 'SIGKILL' });
        return 'quit';
      }
      if (await settledWithin(boundMs)) return 'quit';
    }
  }

  return { needsConfirm: () => writes().length > 0, quitNow, run };
}

/**
 * Closing one tab while its git ops run: ask (write queued or running) "Cancel and Close" / "Keep
 * Running", then cancel that tab's ops and close at once. The app keeps running, so there is no
 * wait and no kill here: a cancelled git dies on its signal, and an uncancellable phase finishes
 * in main on its own (the quit guard still sees it until then). Smoke mode never asks.
 * @param {{
 *   runner: {running(): {op, write}[], cancelAll(): number},
 *   confirm: (kind: 'close', names: string) => Promise<boolean>,
 *   log?: (msg: string) => void, smoke?: boolean,
 * }} o  runner: the tab's view of the runner (only its ops). confirm true = Cancel and Close.
 * @returns {{needsConfirm(): boolean, run(): Promise<'close'|'stay'>}}
 */
function createCloseGuard({ runner, confirm, log = () => {}, smoke = false }) {
  const writes = () => runner.running().filter((r) => r.write);
  async function run() {
    const busy = writes();
    if (busy.length) {
      const names = opNames(busy);
      if (smoke) log(`closing a tab: cancelling running git operations (${names})`);
      else if (!(await confirm(DIALOG_KINDS.CLOSE, names))) return 'stay';
      else log(`closing a tab: cancelled ${names}`);
    }
    runner.cancelAll(); // its reads too (and writes queued behind another tab's)
    return 'close';
  }
  return { needsConfirm: () => writes().length > 0, run };
}

/**
 * One quit decision at a time, and what happens once it says quit (main's before-quit, the
 * window's close and the crash prompt's Quit all go through request()).
 * @param {{
 *   guard: {needsConfirm(): boolean, run(): Promise<'quit'|'stay'>},
 *   quit: () => void,
 *   log?: {info(msg: string, fields?: object): void, error(msg: string, fields?: object): void},
 *   running?: () => string[],
 * }} o  quit: called once the guard said quit (app.quit). running: the op names still listed,
 *   for the decision record.
 * @returns {{request(): Promise<void>, needsConfirm(): boolean, readonly approved: boolean}}
 *   request: ask the guard (joins a decision in progress). A guard that fails counts as 'quit'.
 *   approved: the guard said quit; before-quit and the window close let the quit through.
 *   needsConfirm: a quit now must go through request() first (not approved, and a write runs).
 */
function createQuitFlow({ guard, quit, log = { info() {}, error() {} }, running = () => [] }) {
  let pending = null;
  let approved = false;
  function request() {
    if (!pending) {
      pending = guard.run()
        .catch((err) => {
          log.error('quit guard failed; quitting', { err });
          return 'quit';
        })
        .then((decision) => {
          pending = null;
          log.info('quit decision', { decision, running: running() });
          if (decision !== 'quit') return;
          approved = true;
          quit();
        });
    }
    return pending;
  }
  return { request, needsConfirm: () => !approved && guard.needsConfirm(), get approved() { return approved; } };
}

/**
 * The guards' confirm(kind, names) over a native dialog: `ask(options)` shows dialogOptions(kind,
 * names) and resolves true when the first button (Cancel and Quit / Close, Quit) was chosen.
 * @param {(options: object) => Promise<boolean>} ask
 */
const confirmWith = (ask) => (kind, names) => ask(dialogOptions(kind, names));

// A cancelled clone's partial folder is removed by src/clone-cleanup.js, which no guard waits for:
// what a quit cuts short is finished at the next launch.
const CLONE_NOTE = 'A clone that is cancelled leaves no folder behind: its partial folder is removed, at the next start if needed.';

/** True when `names` (opNames: "push, clone") lists a clone. */
const hasClone = (names) => String(names).split(', ').includes('clone');

/**
 * The UNSAFE question's detail, by what outlived the bound: undo's reversal and a discard's
 * backup record restore files; a clone is a git that ignored its kill.
 */
const UNSAFE_DETAIL = Object.freeze({
  clone: 'Git is still stopping. Quitting now may leave a partial folder: the next start removes it if its download hadn\'t finished, and otherwise leaves it for you to check.',
  default: 'It is restoring files and will finish on its own. Quitting now could leave the worktree half-restored.',
});

/**
 * The native dialogs' wording for confirm(kind, names): {message, detail, buttons, defaultId, cancelId}.
 * kind: 'running' / 'unsafe' (quitting, createQuitGuard) or 'close' (closing a tab, createCloseGuard).
 * A clone among `names` adds what happens to its folder (RUNNING / CLOSE), or is the UNSAFE detail.
 */
function dialogOptions(kind, names) {
  const note = hasClone(names) ? ` ${CLONE_NOTE}` : '';
  if (kind === DIALOG_KINDS.CLOSE) {
    return {
      type: 'warning',
      message: `A git operation is still running in this tab (${names})`,
      detail: `Closing the tab cancels it. Keep it running to let it finish first.${note}`,
      buttons: ['Cancel and Close', 'Keep Running'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    };
  }
  if (kind === DIALOG_KINDS.RUNNING) {
    return {
      type: 'warning',
      message: `A git operation is still running (${names})`,
      detail: `Quitting cancels it. Keep it running to let it finish first.${note}`,
      buttons: ['Cancel and Quit', 'Keep Running'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    };
  }
  return {
    type: 'warning',
    message: `A git operation can't be cancelled right now (${names})`,
    // Only a clone (names lists what outlived the bound): its own detail; with undo or a discard
    // among them, theirs (restoring files is the graver risk).
    detail: names === 'clone' ? UNSAFE_DETAIL.clone : UNSAFE_DETAIL.default,
    buttons: ['Quit', 'Wait'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
}

module.exports = { createQuitGuard, createCloseGuard, createQuitFlow, confirmWith, dialogOptions, DIALOG_KINDS };
