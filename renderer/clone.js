'use strict';
// Clone Repository… (plain script; exposes window.PLClone; loads after components/repo-picker.js,
// before app.js; docs/plans/clone-repository.md §7). Three chained modals on Components.dialog.modal:
// the form, the progress, then what happened. App-level, like PLRepoPicker.openFolder: it needs no
// store and no repo (a start-screen tab clones too).
//
//   open({onError})    the whole flow: main's defaults, the form, the clone with its progress and
//                      Cancel, then a notice, an explanation (with Back to the form) or Open Anyway.
//                      A clone this tab is running already is shown instead of a new form.
//   fromMenu({onError}) File > Clone Repository… ('menu-command' {id: 'clone'}): open(), unless a
//                      dialog or menu has the keyboard (as the global shortcuts stand down). True
//                      when it opened.
//   resume({onError})  on page load: reattach to the clone this tab started, if it still runs (a
//                      reload or a crashed page; the tab's session survived).
//   _internal          the pure parts, unit-tested without a DOM.
//
// Clones come from remotes only: a typed https, http, ssh, scp-like or git URL. The page never
// names a path: the parent comes from main's folder dialog and is shown (and sent back) as main's
// display; the URL and the folder name are checked here as the user types (window.PLCloneUrl, the rules main enforces again). onError gets errors and notices
// ({message, level: 'info'}), as app.js' toast takes both. Only the progress modal's Cancel button
// cancels (Esc and the backdrop do nothing there); another dialog forcing it shut leaves the clone
// running, and its outcome then comes as a toast. All text goes through textContent.
(function () {
  const { el, util } = window.Components;
  const { toError, displayName: dn } = util;
  const Url = () => window.PLCloneUrl; // ../src/clone-url.js, loaded before components.js
  const dialog = () => window.Components.dialog;
  const api = () => window.api;
  const platform = () => util.PLATFORM;

  const WAIT_MS = 30000; // no progress frame for this long: "Waiting…"
  const LIVE_MS = 1000; // the screen reader's progress line: at most once per this
  const POLL_MS = 1000; // a reattached clone: how often main is asked whether it still runs
  const WIN_LONG_PATH = 200; // Git for Windows without core.longpaths: deep paths fail beyond 260

  // ---------------------------------------------------------------- pure

  const UNITS = ['KiB', 'MiB', 'GiB', 'TiB'];

  /** An amount in git's binary units: 512 -> '512 bytes', 12900000 -> '12.3 MiB'; '' for none. */
  function formatBytes(n) {
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '';
    if (n < 1024) return `${Math.round(n)} bytes`;
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < UNITS.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v.toFixed(1)} ${UNITS[i]}`;
  }

  /** A rate in bytes per second: '4.1 MiB/s'; '' for none. */
  const formatRate = (n) => (formatBytes(n) ? `${formatBytes(n)}/s` : '');

  const count = (n) => Number(n).toLocaleString('en-US');

  /** git's phase name; the server's phases (remote: lines) read "Server: counting objects". */
  const phaseLabel = (f) => (f.remote ? `Server: ${String(f.phase).toLowerCase()}` : String(f.phase));

  /** One progress frame as text: 'Receiving objects 45% (1,234 / 2,741) · 12.3 MiB · 4.1 MiB/s'. */
  function progressText(f) {
    if (!f || !f.phase) return '';
    let counts = '';
    if (Number.isInteger(f.current)) counts = Number.isInteger(f.total) ? `(${count(f.current)} / ${count(f.total)})` : `(${count(f.current)})`;
    const head = [phaseLabel(f), Number.isInteger(f.percent) ? `${f.percent}%` : '', counts].filter(Boolean).join(' ');
    return [head, formatBytes(f.bytes), formatRate(f.rate)].filter(Boolean).join(' · ');
  }

  /** The folder name shown: the one derived from the URL until the user edits it. */
  const nameState = (touched, derived, typed) => (touched ? typed : derived);

  /** `name` in the parent folder as shown ('~/code' + 'repo' -> '~/code/repo'), with the platform's separator. */
  function joinShown(parent, name, plat = platform()) {
    const sep = plat === 'win32' ? '\\' : '/';
    const p = String(parent || '');
    return p.endsWith('/') || p.endsWith('\\') ? `${p}${name}` : `${p}${sep}${name}`;
  }

  const NOTES = {
    insecure: 'http:// and git:// aren\'t encrypted: anyone on the network can read or change what you clone.',
    'user-in-url': 'The user name in the URL is saved in the repository\'s settings.',
  };
  const notesText = (notes) => (Array.isArray(notes) ? notes.map((n) => NOTES[n]).filter(Boolean).join(' ') : '');

  /** ssh's user@host for a typed URL (the host-key hint), or the host alone. */
  function sshTarget(url) {
    const u = Url() ? Url().parseCloneUrl(url) : { ok: false };
    if (!u.ok) return { host: 'the server', who: 'git@<host>' };
    return { host: u.host, who: u.user ? `${u.user}@${u.host}` : u.host };
  }

  /**
   * What to tell the user about a failed clone `err` (kind and message from main): {title,
   * message, detail}. `req`: the form's values ({url}). detail: git's (cleaned) text.
   */
  function errorView(err, req = {}) {
    const text = err && err.message ? String(err.message) : '';
    const kit = window.PLFlowKit;
    switch (err && err.kind) {
      case 'auth':
        return { title: 'Authentication failed', message: kit ? kit.authMessage() : 'Git could not authenticate with the remote.', detail: text };
      case 'host-key': {
        const { host, who } = sshTarget(req.url);
        return {
          title: 'Unknown host key',
          message: `ssh doesn't know ${dn(host)} yet and can't ask here. Connect once from a terminal (ssh -T ${dn(who)}) to check and accept its key, then try again.`,
          detail: text,
        };
      }
      case 'not-found':
        if (err.state === 'parent') return { title: 'Choose another folder', message: text };
        return { title: 'Repository not found', message: 'Check the URL. For a private repository this can also mean you aren\'t signed in (many hosts answer "not found" instead of "forbidden").', detail: text };
      case 'unreachable':
        return { title: 'Can\'t reach the server', message: 'Check the address and your network connection, then try again.', detail: text };
      case 'exists':
        return { title: 'Folder already exists', message: `${text.replace(/\.$/, '')}. Choose another name or folder.` };
      case 'no-access':
        return { title: 'Can\'t create the folder', message: text };
      case 'no-space':
        return { title: 'The disk is full', message: text };
      case 'path-too-long':
        return { title: 'The path is too long', message: text };
      case 'unsafe-repo':
        return { title: 'Git refuses the repository', message: 'Git doesn\'t trust a repository owned by another user.', detail: text };
      case 'unsupported':
        return {
          title: 'This kind of URL isn\'t supported',
          message: 'Your git settings rewrite this URL (url.<base>.insteadOf) to a transport Pasta Lite doesn\'t use. Clone it from a terminal.',
          detail: text,
        };
      case 'stale':
        return { title: 'The folder changed', message: 'The folder changed (another tab chose a different one). Check it and try again.' };
      case 'in-progress':
        return err.state === 'cleanup'
          ? { title: 'The previous clone\'s folder is still being removed', message: 'Try again in a moment, or choose another name.' }
          : { title: 'A clone is already running in this tab', message: 'Wait for it to finish, or cancel it.' };
      case 'invalid-args':
        return { title: 'Can\'t clone', message: text };
      default:
        return { title: 'Clone failed', message: 'See Help → Show Logs for details.', detail: text };
    }
  }

  // ---------------------------------------------------------------- events

  // Main sends 'clone-progress' to this tab only: frames of the clone with that opId, and a removal
  // that failed after its dialog closed. One subscription for the page's life.
  const views = new Map(); // opId -> the progress view showing it
  let reportTo = (e) => util.log.error(e);
  let listening = false;

  function listen(onError) {
    reportTo = onError;
    if (listening) return;
    listening = true;
    try {
      api().on('clone-progress', (e) => {
        if (!e || typeof e !== 'object') return;
        if (e.cleanup === 'failed') {
          reportTo(new Error(`A partial folder was left at ${dn(e.leftover)}: delete it by hand.`));
          return;
        }
        const v = views.get(e.opId); // frames of another opId are ignored
        if (v) v.frame(e);
      });
    } catch { /* a main without the event: no progress, the clone still runs */ }
  }

  const notify = (onError, message) => onError({ message, level: 'info' });

  // ---------------------------------------------------------------- the form

  const label = (text, forEl) => {
    const l = el('label', 'dlg-label', text);
    l.htmlFor = forEl.id;
    return l;
  };
  let idSeq = 0;
  const field = (cls) => {
    const i = el('input', `dlg-input ${cls}`);
    i.type = 'text';
    i.id = `clone-${cls}-${++idSeq}`;
    i.spellcheck = false;
    i.setAttribute('autocomplete', 'off');
    return i;
  };
  const errorLine = (input) => {
    const p = el('p', 'dlg-error');
    p.id = `${input.id}-error`;
    p.setAttribute('role', 'alert');
    p.hidden = true;
    input.setAttribute('aria-describedby', p.id);
    return p;
  };
  const button = (text, title) => {
    const b = el('button', 'btn', text);
    b.type = 'button';
    if (title) b.title = title;
    return b;
  };

  /**
   * The form. `init`: {url, name, touched, parent: {display, chars} | null}. Resolves its values
   * ({url, name, touched, parent}) on Clone, null on Cancel / Esc.
   */
  function form(init) {
    const plat = platform();
    let parent = init.parent || null;
    let touched = !!init.touched;
    let submitted = false;
    let urlEdited = !!init.url;

    const url = field('clone-url');
    url.placeholder = 'https://github.com/org/repo.git';
    const notes = el('p', 'clone-note');
    const urlError = errorLine(url);

    const parentText = field('clone-parent');
    parentText.readOnly = true;
    parentText.placeholder = 'Choose a folder';
    const choose = button('Choose…', 'Choose where to clone');
    const parentRow = el('div', 'clone-row');
    parentRow.append(parentText, choose);
    const parentError = errorLine(parentText);

    const name = field('clone-name');
    const nameError = errorLine(name);
    const preview = el('p', 'clone-note clone-preview');
    const longWarn = el('p', 'clone-note clone-warn');
    longWarn.hidden = true;

    const derived = () => Url().deriveName(url.value, { platform: plat });

    url.value = String(init.url || '');
    parentText.value = parent ? parent.display : '';
    name.value = nameState(touched, derived(), String(init.name || ''));

    let okEl = null;
    const errors = () => {
      const r = Url().parseCloneUrl(url.value);
      return {
        url: r.ok ? null : r.reason, notes: r.ok ? notesText(r.notes) : '',
        parent: parent ? null : 'Choose a folder to clone into',
        name: Url().nameError(name.value, { platform: plat }),
      };
    };
    const show = (line, input, msg, visible) => {
      line.textContent = visible && msg ? msg : '';
      line.hidden = !(visible && msg);
      input.setAttribute('aria-invalid', visible && msg ? 'true' : 'false');
    };
    function refresh() {
      const e = errors();
      show(urlError, url, e.url, urlEdited || submitted);
      notes.textContent = e.notes;
      notes.hidden = !e.notes;
      show(parentError, parentText, e.parent, submitted);
      show(nameError, name, e.name, touched || submitted || !!name.value);
      const where = parent ? joinShown(parent.display, name.value, plat) : '';
      preview.textContent = where && !e.name ? `Will create ${where}` : '';
      preview.hidden = !preview.textContent;
      const long = plat === 'win32' && parent && Number.isInteger(parent.chars) && parent.chars + 1 + name.value.length > WIN_LONG_PATH;
      longWarn.textContent = long ? 'This path is long: without core.longpaths, Git for Windows can\'t check out files whose full path is over 260 characters.' : '';
      longWarn.hidden = !long;
      if (okEl) okEl.disabled = !!(e.url || e.parent || e.name);
      return e;
    }
    const values = () => ({
      url: url.value.trim(),
      name: name.value,
      touched,
      parent,
    });
    const submit = () => {
      submitted = true;
      const e = refresh();
      if (e.url) { url.focus(); return null; }
      if (e.parent) { choose.focus(); return null; }
      if (e.name) { name.focus(); return null; }
      return { value: values() };
    };

    url.addEventListener('input', () => {
      urlEdited = true;
      if (!touched) name.value = derived();
      refresh();
    });
    name.addEventListener('input', () => {
      touched = name.value !== '';
      refresh();
    });
    choose.addEventListener('click', () => {
      api().clone.pickParent().then((r) => {
        if (!r) return;
        parent = r;
        parentText.value = r.display;
        refresh();
      }, (e) => reportTo(toError(e)));
    });

    const box = el('div', 'clone-form');
    box.append(
      label('Repository URL', url), url, notes, urlError,
      label('Clone into', parentText), parentRow, parentError,
      label('Folder name', name), name, nameError, preview, longWarn,
    );
    const texts = [url, name];
    const { promise, buttons } = dialog().modal({
      title: 'Clone a repository',
      wide: true,
      body: [box],
      fields: [url, choose, name],
      buttons: [{ label: 'Cancel', value: null, cls: '' }, { label: 'Clone', value: 'ok', cls: 'btn-primary' }],
      onEnter: (active) => (texts.includes(active) || active === parentText ? submit() : undefined),
      onButton: (b) => (b.value === 'ok' ? submit() : { value: null }),
      focus: () => url,
      cancelValue: null,
    });
    okEl = buttons[buttons.length - 1];
    refresh();
    return promise;
  }

  // ---------------------------------------------------------------- progress

  /**
   * The progress modal of clone `opId`: {frame(f), isOpen(), close(), closed, cancelling}. Only its
   * Cancel button cancels (api.app.cancel), then reads "Cancelling…" until the clone settles.
   * Its "Waiting…" note adds, while no frame came yet, why a server may be waiting for a password.
   */
  function progressView({ opId, lead }) {
    const leadEl = el('p', 'dlg-message clone-lead', lead);
    const phase = el('p', 'clone-phase', 'Starting…');
    const bar = el('progress', 'clone-bar');
    bar.max = 100;
    const live = el('p', 'clone-live');
    live.setAttribute('aria-live', 'polite');
    const wait = el('p', 'clone-note clone-wait');
    wait.hidden = true;
    let frames = 0;
    let cancelling = false;
    let stopped = false;
    let waitTimer = null;
    let liveTimer = null;
    let lastLive = -Infinity;
    let pendingLive = '';

    const indeterminate = (on) => {
      if (on) bar.removeAttribute('value');
      bar.classList.toggle('is-indeterminate', on);
    };
    indeterminate(true);

    function cancel() {
      if (cancelling) return;
      cancelling = true;
      cancelBtn.disabled = true;
      cancelBtn.textContent = 'Cancelling…';
      phase.textContent = 'Cancelling…';
      api().app.cancel(opId).catch((e) => reportTo(toError(e)));
    }
    const { promise, buttons } = dialog().modal({
      title: 'Cloning',
      body: [leadEl, phase, bar, live, wait],
      buttons: [{ label: 'Cancel', value: 'cancel', cls: '' }],
      onButton: () => { cancel(); return null; },
      onDismiss: () => false, // Esc and the backdrop do nothing: only the button cancels
      focus: (b) => b[0],
      cancelValue: 'forced',
    });
    const cancelBtn = buttons[0];

    function showWait() {
      if (stopped) return;
      const kit = window.PLFlowKit;
      const hint = !frames && kit
        ? `\n\nIf the server needs a password or an SSH key passphrase, Pasta Lite can't ask for it yet. ${kit.authMessage()}`
        : '';
      wait.textContent = `Waiting…${hint}`;
      wait.hidden = false;
    }
    const armWait = () => {
      clearTimeout(waitTimer);
      waitTimer = setTimeout(showWait, WAIT_MS);
    };
    armWait();

    function speak(text) {
      pendingLive = text;
      const since = Date.now() - lastLive;
      if (since >= LIVE_MS) {
        lastLive = Date.now();
        live.textContent = pendingLive;
        return;
      }
      if (!liveTimer) {
        liveTimer = setTimeout(() => {
          liveTimer = null;
          if (stopped) return;
          lastLive = Date.now();
          live.textContent = pendingLive;
        }, LIVE_MS - since);
      }
    }

    return {
      closed: promise,
      get cancelling() { return cancelling; },
      isOpen: () => !!cancelBtn.isConnected,
      frame(f) {
        if (stopped) return;
        frames++;
        wait.hidden = true;
        armWait();
        if (cancelling) return;
        const text = progressText(f);
        phase.textContent = text;
        if (Number.isInteger(f.percent)) {
          indeterminate(false);
          bar.value = f.percent;
        } else {
          indeterminate(true);
        }
        speak(text);
      },
      cancel,
      /** Stop the timers and close the modal if it is still this one (never another dialog). */
      close() {
        stopped = true;
        clearTimeout(waitTimer);
        clearTimeout(liveTimer);
        if (cancelBtn.isConnected) dialog().close();
      },
    };
  }

  // ---------------------------------------------------------------- the outcome

  /** A clone that finished (`res`: {status, target, name, submodules, opened, reason, openError}) and was opened, or not. */
  async function announce(res, onError) {
    const target = dn(res.target);
    if (res.opened) {
      const sub = res.submodules ? ' It has submodules, which were not cloned: run git submodule update --init in a terminal.' : '';
      notify(onError, `Cloned ${dn(res.name || res.opened.name)}.${sub}`);
      return;
    }
    if (res.openError) {
      await dialog().alert({ title: `Cloned to ${target}, but it couldn't be opened`, message: String(res.openError.message || '') });
      return;
    }
    if (res.reason === 'declined') notify(onError, `Cloned to ${target}. It was not opened.`);
    else if (res.reason !== 'closed') notify(onError, `Cloned to ${target}.`);
  }

  /** A checkout failure: what git said, and Open Anyway (api.clone.openCloned). */
  async function checkoutFailed(res, opId, onError) {
    const pick = await dialog().choose({
      title: 'The repository was cloned, but some files could not be checked out',
      message: `It is in ${dn(res.target)}. Opened as it is, the missing files show as deleted.`,
      detail: res.message || '',
      choices: [{ value: 'open', label: 'Open Anyway', primary: true }],
      cancelLabel: 'Close',
    });
    if (pick !== 'open') return;
    try {
      await announce({ ...res, ...(await api().clone.openCloned(opId)) }, onError);
    } catch (e) {
      onError(toError(e));
    }
  }

  /** The outcome in dialogs (the progress modal was still showing). Resolves {back, stale} for Back. */
  async function settle({ req, opId, res, err, onError }) {
    if (err) {
      if (err.kind === 'aborted') {
        notify(onError, 'Clone cancelled');
        return null;
      }
      const view = errorView(err, req);
      const pick = await dialog().choose({
        title: view.title,
        message: view.message,
        detail: view.detail || '',
        choices: [{ value: 'back', label: 'Back', primary: true }],
        cancelLabel: 'Close',
      });
      return pick === 'back' ? { back: true, stale: err.kind === 'stale' } : null;
    }
    if (res.status === 'checkout-failed') await checkoutFailed(res, opId, onError);
    else await announce(res, onError);
    return null;
  }

  /** The outcome as a toast (the progress modal was forced shut by another dialog). */
  function background({ req, res, err, onError }) {
    if (err) {
      if (err.kind === 'aborted') notify(onError, 'Clone cancelled');
      else {
        const view = errorView(err, req);
        onError(Object.assign(new Error(`${view.title}: ${view.detail || view.message}`), { kind: err.kind }));
      }
      return;
    }
    if (res.status === 'checkout-failed') {
      notify(onError, `Cloned to ${dn(res.target)}, but some files could not be checked out.`);
      return;
    }
    if (res.openError) onError(new Error(`Cloned to ${dn(res.target)}, but it couldn't be opened: ${res.openError.message}`));
    else announce(res, onError);
  }

  // ---------------------------------------------------------------- the flow

  const pending = new Set(); // opIds this page started and still awaits

  /** Run the clone of the form's values `req`: progress, then the outcome. Resolves settle()'s answer. */
  async function run(req, onError) {
    const opId = api().newOpId();
    const target = joinShown(req.parent.display, req.name);
    const view = progressView({ opId, lead: `Cloning ${dn(req.url)} into ${dn(target)}` });
    views.set(opId, view);
    pending.add(opId);
    let res = null;
    let err = null;
    try {
      res = await api().clone.start(opId, { url: req.url, name: req.name, parent: req.parent.display });
    } catch (e) {
      err = toError(e);
    } finally {
      pending.delete(opId);
    }
    const shown = views.get(opId) || view; // a reattached view replaces a forced-shut one
    views.delete(opId);
    const open = shown.isOpen();
    shown.close();
    if (!open) {
      background({ req, res, err, onError });
      return null;
    }
    return settle({ req, opId, res, err, onError });
  }

  const loops = new Map(); // opId -> the poll loop of a reattached view ({stop})

  /**
   * How a clone this page didn't start ended, from main's record of the tab's last clone
   * (app:cloneDefaults `last`, src/clone-service.js): told as run() tells a clone whose dialog was
   * forced shut. Nothing recorded for that opId: only that it ended.
   */
  function reportLast(out, running, onError) {
    if (!out) {
      notify(onError, running.target ? `The clone into ${dn(running.target)} has ended.` : 'The clone has ended.');
      return;
    }
    const req = out.req || {};
    if (out.status === 'failed') {
      background({ req, err: Object.assign(new Error((out.error && out.error.message) || 'The clone failed'), out.error || {}), onError });
      return;
    }
    background({ req, res: { ...out, opened: out.opened ? { name: out.name } : null }, onError });
  }

  /**
   * Show the progress of clone `running` ({opId, target}: main's, for this tab). When this page
   * started it, run() still awaits it and reports the outcome. After a reload, main is asked once
   * a second until the clone no longer runs; how it ended is then main's record of this tab's last
   * clone, never another tab's events. Idempotent: attaching again replaces the earlier loop.
   */
  function attach(running, onError) {
    const { opId } = running;
    const old = views.get(opId);
    if (old && old.isOpen()) return;
    if (loops.has(opId)) loops.get(opId).stop();
    const view = progressView({ opId, lead: running.target ? `Cloning into ${dn(running.target)}` : 'Cloning…' });
    views.set(opId, view);
    if (pending.has(opId)) return; // run() reports the outcome
    let stopped = false;
    const loop = { stop: () => { stopped = true; } };
    loops.set(opId, loop);
    const done = (d) => {
      loop.stop();
      if (loops.get(opId) === loop) loops.delete(opId);
      if (views.get(opId) === view) views.delete(opId);
      const shown = view.isOpen();
      view.close();
      if (shown) reportLast(d && d.last && d.last.opId === opId ? d.last : null, running, onError);
    };
    const poll = () => {
      if (stopped) return;
      api().clone.defaults().then((d) => {
        if (stopped) return;
        if (d && d.running && d.running.opId === opId) setTimeout(poll, POLL_MS);
        else done(d);
      }, () => { if (!stopped) setTimeout(poll, POLL_MS); });
    };
    setTimeout(poll, POLL_MS);
  }

  /** The form's first values from main's defaults (`d`). */
  const initial = (d) => ({ url: '', name: '', touched: false, parent: d.parent || null });

  /** Clone Repository…: see the header. */
  async function open({ onError = (e) => util.log.error(e) } = {}) {
    listen(onError);
    try {
      let d = await api().clone.defaults();
      if (d.running) {
        attach(d.running, onError);
        return;
      }
      let values = initial(d);
      for (;;) {
        const req = await form(values);
        if (!req) return;
        const back = await run(req, onError);
        if (!back) return;
        values = { ...req };
        if (back.stale) {
          // Back with main's current parent (another tab chose a different one).
          d = await api().clone.defaults();
          values.parent = d.parent || null;
        }
      }
    } catch (e) {
      onError(toError(e));
    }
  }

  /** File > Clone Repository… (see the header). */
  function fromMenu(o) {
    if (util.modalOpen()) return false;
    open(o);
    return true;
  }

  /** On page load: reattach to this tab's running clone, if any (see the header). */
  async function resume({ onError = (e) => util.log.error(e) } = {}) {
    listen(onError);
    try {
      const d = await api().clone.defaults();
      if (d && d.running) attach(d.running, onError);
    } catch (e) {
      util.log.warn('could not ask main for a running clone', e);
    }
  }

  const PLClone = {
    open, fromMenu, resume,
    _internal: { formatBytes, formatRate, progressText, phaseLabel, errorView, nameState, joinShown, notesText, WAIT_MS }, // for unit tests only
  };
  window.PLClone = PLClone;
  if (typeof module !== 'undefined') module.exports = PLClone;
})();
