'use strict';
// The clone use cases behind the IPC channels (docs/plans/clone-repository.md §6.2): the dialog's
// defaults, the parent folder dialog, running a clone in the shared runner and opening what it made.
// Free of Electron: the runner, the opening use cases, clone.json, the cleanup and the folder
// dialog are passed in, so it is unit-tested with fakes.
//
// Security boundary: the page never sends a path, and never names a local source. The parent is
// main's (its folder dialog, clone.json's last parent, else the home folder); the page only echoes
// its display back, and a mismatch (another tab picked another folder meanwhile) is refused as
// 'stale'. The source is a typed URL that must pass parseCloneUrl (a network URL: local paths and
// file:// are refused), and the name nameError (one segment). Main builds the target.
const os = require('node:os');
const path = require('node:path');
const { kindError } = require('./exec');
const { parseCloneUrl, nameError } = require('./clone-url');
const { homeShort, samePath, isDir } = require('./fs-paths');
const { serializeError, logError } = require('./ipc-errors');
const { EVENTS, ownedOpId } = require('./ipc-contract');

/**
 * @param {{
 *   runner: {run(repo: string, name: string, args: any[], o: {opId: string, owner: number}): Promise<object>},
 *   opening: {openCloned(session: object, dir: string, o?: {newTab?: boolean}): Promise<{info: object|null, reason?: string}>,
 *     rememberRecent(dir: string): Promise<void>},
 *   prefs: {lastParent(): Promise<string|null>, setLastParent(abs: string): Promise<void>},
 *   cleanup: {journal(made): Promise<void>, forget(made): Promise<void>, remove(made: object): Promise<string>,
 *     running(): {abs: string}[]},
 *   pickFolder: (o: {defaultPath?: string}) => Promise<string|null>,
 *   home: () => string|null,
 *   log: {info: Function, warn: Function},
 *   platform?: string, homeDir?: () => string,
 * }} o  pickFolder: main's "Choose where to clone" dialog (the smoke harness answers it from its environment), null
 *   when cancelled. home: the default parent (null in a smoke run: never the real home folder).
 *   homeDir: what the displays shorten to '~' (os.homedir).
 */
function createCloneService({ runner, opening, prefs, cleanup, pickFolder, home, log, platform = process.platform, homeDir = os.homedir }) {
  // session id -> {opId, target, started, cancelled, made}: the page's opId, the target as shown
  // (null until it is known), whether the runner has the op, a cancel that came before it did, the
  // folder the clone made. Set before anything is awaited, so a second clone from the tab is refused.
  const running = new Map();
  const last = new Map(); // session id -> the outcome of its last clone (a reloaded page reads it)
  let kept = null; // {opId (owned), root}: the last clone whose checkout failed, for Open Anyway

  const display = (abs) => homeShort(abs, homeDir(), { platform });

  /** A refusal before the runner: logged as an op failure is (kind and name only), then thrown. */
  const refuse = (err) => {
    log.info('clone refused', { kind: err.kind, err: logError(err) });
    return err;
  };

  /** The parent folder now: clone.json's last one (still a directory), else home(), else null. */
  async function currentParent() {
    const last = await prefs.lastParent();
    if (last) return last;
    const h = home();
    return h && path.isAbsolute(h) && await isDir(h) ? h : null;
  }

  /** The parent as the page sees it: {display, chars} (chars: its length, for Windows' long-path warning). */
  const parentView = (abs) => (abs ? { display: display(abs), chars: abs.length } : null);

  /**
   * The open use cases for a clone that finished: this tab (a start screen) or a new one next to
   * it, one more try in a new tab when a newer open landed in this tab meanwhile, and not at all
   * when the tab closed (the recent list gets it). Never rejects: a clone that can't be opened
   * still succeeded ({openError}).
   */
  async function openIt(session, dir) {
    const closed = () => {
      opening.rememberRecent(dir).catch(() => {});
      log.info('a clone finished after its tab closed: added to the recent list, not opened', { tab: session.id });
      return { opened: null, reason: 'closed' };
    };
    if (session.closed) return closed();
    try {
      let res = await opening.openCloned(session, dir);
      if (!res.info && res.reason === 'stale' && !session.closed) res = await opening.openCloned(session, dir, { newTab: true });
      if (res.info) return { opened: res.info };
      if (res.reason === 'closed' || session.closed) return closed();
      return { opened: null, reason: res.reason };
    } catch (err) {
      log.warn('a clone could not be opened', { err: logError(err) });
      return { opened: null, openError: serializeError(err) };
    }
  }

  /** app:clone's work once the tab's running entry is set (see clone below). */
  async function cloneIn(session, req, opId, entry) {
    const parent = await currentParent();
    if (!parent) throw refuse(kindError('not-found', 'Choose a folder to clone into', { state: 'parent' }));
    if (display(parent) !== req.parent) throw refuse(kindError('stale', 'The folder changed; check it and try again', { state: 'parent' }));
    const u = parseCloneUrl(req.url);
    if (!u.ok) throw refuse(kindError('invalid-args', u.reason));
    const source = u.url;
    const bad = nameError(req.name, { platform });
    if (bad) throw refuse(kindError('invalid-args', bad));
    const target = path.join(parent, req.name);
    if (cleanup.running().some((m) => samePath(m.abs, target, { platform }))) {
      throw refuse(kindError('in-progress', 'The previous clone\'s folder is still being removed', { state: 'cleanup', leftover: display(target) }));
    }
    entry.target = display(target);
    if (entry.cancelled) throw refuse(kindError('aborted', 'Clone cancelled'));
    const hooks = {
      onProgress: (frame) => session.send(EVENTS.CLONE_PROGRESS, { opId, ...frame }),
      // Pending in clone.json from the moment it exists: a quit, a crash or a git that outlives
      // its kill can't abandon it (src/clone-cleanup.js).
      onMade: (made) => {
        entry.made = made;
        cleanup.journal(made);
      },
    };
    entry.started = true; // no await from here to runner.run: app:cancel now goes to the runner
    let res;
    try {
      res = await runner.run(target, 'clone', [{ source, parent, name: req.name }, hooks], {
        opId: ownedOpId(session.id, opId), owner: session.id,
      });
    } catch (err) {
      const made = (err && err.made) || entry.made;
      if (made) removeMade(session, opId, made);
      throw err;
    }
    if (entry.made) cleanup.forget(entry.made); // the user's repository now, whatever opens
    const outcome = { status: res.status, target: display(res.root), name: res.name, submodules: !!res.submodules, empty: !!res.empty, opened: null };
    if (res.status === 'checkout-failed') {
      kept = { opId: ownedOpId(session.id, opId), root: res.root };
      remember(session, opId, req, { status: res.status, target: outcome.target, name: res.name, opened: false });
      return { ...outcome, message: res.message };
    }
    const done = { ...outcome, ...(await openIt(session, res.root)) };
    remember(session, opId, req, { status: 'done', target: done.target, name: done.name, opened: !!done.opened, ...(done.reason ? { reason: done.reason } : {}) });
    return done;
  }

  /**
   * What a reattached page needs to tell the user how clone `opId` ended: {opId, req: {url},
   * status: 'done' | 'checkout-failed' | 'failed', target, name, opened, reason?} or, failed,
   * {error: {message, kind, state, ...}} (what renderer/clone.js errorView reads; the message is
   * cloneRepo's, redacted). req.url: the typed URL (credentials in it were refused).
   */
  function remember(session, opId, req, outcome) {
    last.set(session.id, { opId, req: { url: String(req.url) }, ...outcome });
  }

  /** The removal of what a failed clone made; the page hears of a failure (the folder is left). */
  function removeMade(session, opId, made) {
    cleanup.remove(made).then((outcome) => {
      if (outcome === 'failed') session.send(EVENTS.CLONE_PROGRESS, { opId, cleanup: 'failed', leftover: display(made.abs) });
    }, () => {});
  }

  return {
    /**
     * app:cloneDefaults: {parent: {display, chars} | null, running: {opId, target} | null,
     * last: outcome | null}. `running`: the clone this tab started
     * and that still runs (a reloaded page reattaches to it; target '' until it is known). `last`:
     * how this tab's last clone ended (remember). `parent` null: there is none (a smoke run
     * without a seed).
     */
    async defaults(session) {
      const r = running.get(session.id);
      return {
        parent: parentView(await currentParent()),
        running: r ? { opId: r.opId, target: r.target || '' } : null,
        last: last.get(session.id) || null,
      };
    },

    /**
     * app:cancel for a clone of this tab the runner doesn't have yet (its checks still run): it
     * will not start. True when that was the case; otherwise the runner cancels it by opId.
     */
    cancelPending(session, opId) {
      const r = running.get(session.id);
      if (!r || r.opId !== opId || r.started) return false;
      r.cancelled = true;
      return true;
    },

    /** app:pickCloneParent: main's folder dialog; the folder chosen is saved at once. {display, chars} or null. */
    async pickParent() {
      const abs = await pickFolder({ defaultPath: (await currentParent()) || undefined });
      if (!abs) return null;
      await prefs.setLastParent(abs);
      return parentView(abs);
    },

    /**
     * app:clone: {url, name, parent} (the coerced request: url is the typed URL, parent the display
     * the page showed). Resolves a
     * CloneOutcome {status: 'done'|'checkout-failed', target, name, submodules, empty, opened,
     * reason?, openError?, message?}. Refusals: in-progress (a clone runs in this tab; the target's
     * previous folder is still being removed), stale (the parent changed),
     * not-found (no parent), invalid-args, then cloneRepo's kinds. A failed clone's folder is
     * removed (src/clone-cleanup.js), not awaited.
     */
    async clone(session, req, opId) {
      if (running.has(session.id)) throw refuse(kindError('in-progress', 'A clone is already running in this tab', { state: 'clone' }));
      const entry = { opId, target: null, started: false, cancelled: false, made: null };
      running.set(session.id, entry); // before the first await: a second submit is refused above
      try {
        return await cloneIn(session, req, opId, entry);
      } catch (err) {
        remember(session, opId, req, { status: 'failed', target: entry.target || '', name: req.name, opened: false, error: serializeError(err) });
        throw err;
      } finally {
        if (running.get(session.id) === entry) running.delete(session.id);
      }
    },

    /**
     * app:openCloned: Open Anyway after a checkout failure, for the clone `opId` of this tab only
     * (else not-found). The one kept target is then forgotten. {opened, reason?, openError?}.
     */
    async openCloned(session, opId) {
      if (!kept || kept.opId !== ownedOpId(session.id, opId)) throw refuse(kindError('not-found', 'That clone is no longer waiting to be opened'));
      const { root } = kept;
      kept = null;
      return openIt(session, root);
    },
  };
}

module.exports = { createCloneService };
