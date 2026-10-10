'use strict';
// In-app modal dialogs (plain script; exposes Components.dialog). Text only via textContent.
//   await Components.dialog.confirm({ title, message, detail, confirmLabel, cancelLabel, danger, defaultCancel }) -> boolean
//     defaultCancel: Cancel is focused and Enter confirms only on the confirm button, as in a danger
//     dialog, without the danger style (e.g. "Rewrite pushed commits?")
//   await Components.dialog.alert({ title, message, detail, okLabel })
//   await Components.dialog.prompt({ title, message, label, value, placeholder, okLabel, cancelLabel, validate })
//     -> string | null (null = cancelled). validate(value) -> error string | null: the error is shown
//     under the field and blocks OK.
//   await Components.dialog.choose({ title, message, detail, danger, choices: [{ value, label, danger?, primary? }],
//     cancelLabel }) -> value | null (null = cancelled). More than two answers (e.g. a rejected push).
//   await Components.dialog.editMessage({ title, message, summary, description, okLabel, cancelLabel, note, validate })
//     -> string | null (null = cancelled). A commit message editor (docs/plans/rebase.md §5.6): summary input with
//     the 72-char counter, description textarea; `message` (split at the first line) or summary + description
//     prefill it. Returns "summary\n\ndescription" (trailing whitespace trimmed). Enter in the summary moves to
//     the description, ⌘↵ / Ctrl+Enter is OK. A blank message (or validate(message) -> error) blocks OK. `note`
//     is shown under the fields; lines starting with # get an inline warning (they are removed when rebasing).
//   await Components.dialog.confirmDiscard(entries, { all }) -> boolean   (file-level discards)
//   Components.dialog.isOpen() -> boolean
//   Components.dialog.modal({...}) -> {promise, buttons}: the shared builder, for a dialog with its
//     own fields and buttons (renderer/clone.js); see modal below.
// Enter confirms (in a danger dialog only while the confirm button has focus; a danger choice is
// never focused by default), Esc / backdrop click cancels (unless the modal's onDismiss says no);
// focus is trapped in the dialog and restored after. One dialog at a time: opening another cancels
// the first, whatever onDismiss says.
(function () {
  const { el, util } = window.Components;
  const Keys = () => window.PLKeys; // keys.js loads before this script
  /** The button class of a choice() option: danger, primary or plain. */
  const choiceClass = (c) => {
    if (c.danger) return 'btn-danger';
    return c.primary ? 'btn-primary' : '';
  };
  let open = null; // {box, cancel}: the one open dialog
  let idSeq = 0;

  /**
   * The shared modal. buttons: [{label, value, cls}] in display order; `body` extra elements after
   * the message; `fields` focusable elements before the buttons (Tab order).
   * onEnter(activeElement, event): {value} closes with value, null swallows the key (stay open),
   * undefined = not handled (Enter on a button then presses it).
   * onButton(button): {value} closes with value, null keeps the dialog open (default: its value).
   * focus(buttonEls): the element to focus first (default: the last button).
   * onDismiss(): asked on Esc and on a backdrop press; false keeps the dialog open (a clone's
   * progress: only its Cancel button cancels). Another dialog opening still closes it.
   * Returns {promise, buttons: [button elements]}; the promise resolves with the chosen value
   * (cancelValue on Esc / backdrop / another dialog opening).
   */
  function modal({ title, message = '', detail = '', danger = false, wide = false, body = [], fields = [], buttons, onEnter = () => undefined, focus, cancelValue, onButton, onDismiss }) {
    if (open) open.cancel();
    const actions = el('div', 'dlg-actions');
    const btns = buttons.map((b) => {
      const e = el('button', `btn${b.cls ? ` ${b.cls}` : ''}`, b.label);
      e.type = 'button';
      actions.append(e);
      return { ...b, el: e };
    });
    const els = btns.map((b) => b.el);
    const promise = new Promise((resolve) => {
      const previous = document.activeElement;
      const backdrop = el('div', 'dlg-backdrop');
      const box = el('div', `dlg${danger ? ' dlg-danger' : ''}${wide ? ' dlg-wide' : ''}`);
      box.setAttribute('role', 'alertdialog');
      box.setAttribute('aria-modal', 'true');
      box.tabIndex = -1; // a click on the text keeps focus inside the dialog
      const h = el('h2', 'dlg-title', title || '');
      h.id = `dlg-title-${++idSeq}`;
      box.setAttribute('aria-labelledby', h.id);
      const msg = el('p', 'dlg-message', message);
      const det = detail ? el('pre', 'dlg-detail', detail) : null;
      box.append(h, msg, ...(det ? [det] : []), ...body, actions);
      backdrop.append(box);
      const focusables = [...fields, ...els];

      const finish = (value) => {
        if (!open || open.box !== box) return;
        open = null;
        document.removeEventListener('keydown', onKey, true);
        backdrop.remove();
        if (previous && typeof previous.focus === 'function' && document.contains(previous)) previous.focus();
        resolve(value);
      };
      const dismiss = () => {
        if (onDismiss && onDismiss() === false) return;
        finish(cancelValue);
      };
      const press = (b) => {
        const r = onButton ? onButton(b) : { value: b.value };
        if (r) finish(r.value);
      };
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); dismiss(); return; }
        if (e.key === 'Enter') {
          const r = onEnter(document.activeElement, e);
          if (r !== undefined) {
            e.preventDefault();
            e.stopPropagation();
            if (r) finish(r.value);
            return;
          }
          const b = btns.find((x) => x.el === document.activeElement);
          if (b) { e.preventDefault(); e.stopPropagation(); press(b); return; }
        }
        if (e.key === 'Tab') { // trap focus inside the dialog
          e.preventDefault();
          const live = focusables.filter((f) => !f.disabled);
          const i = live.indexOf(document.activeElement);
          const step = e.shiftKey ? -1 : 1;
          const next = i === -1 ? 0 : (i + step + live.length) % live.length;
          if (live[next]) live[next].focus();
          return;
        }
        e.stopPropagation(); // keep global shortcuts (graph j/k, diff n/p) away while modal
      }
      for (const b of btns) b.el.addEventListener('click', () => press(b));
      backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) dismiss(); });
      document.addEventListener('keydown', onKey, true);
      document.body.append(backdrop);
      open = { box, cancel: () => finish(cancelValue) };
      (((focus && focus(els)) || els[els.length - 1]) || box).focus();
    });
    return { promise, buttons: els };
  }

  function confirm({ title, message = '', detail = '', confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false, defaultCancel = false, alertOnly = false } = {}) {
    const specs = [
      ...(alertOnly ? [] : [{ label: cancelLabel, value: false, cls: '' }]),
      { label: confirmLabel, value: true, cls: danger ? 'btn-danger' : 'btn-primary' },
    ];
    const guarded = (danger || defaultCancel) && !alertOnly;
    // A destructive action needs the confirm button itself focused; others confirm unless Cancel is.
    // (Enter on Cancel falls through to pressing it.) `els` is set before any key can arrive.
    const onEnter = (active) => {
      const okEl = els[els.length - 1];
      const cancelEl = alertOnly ? null : els[0];
      if (guarded) {
        if (active === okEl) return { value: true };
        return active === cancelEl ? undefined : null;
      }
      return active === cancelEl ? { value: false } : { value: true };
    };
    // Destructive dialogs default to Cancel.
    const focus = (b) => (guarded ? b[0] : b[b.length - 1]);
    const { promise, buttons: els } = modal({ title, message, detail, danger, buttons: specs, onEnter, focus, cancelValue: false });
    return promise;
  }

  /** Message with a single OK button; resolves when dismissed (Enter, Esc, OK or backdrop). */
  const alert = ({ title, message, detail, okLabel = 'OK' } = {}) =>
    api.confirm({ title, message, detail, confirmLabel: okLabel, alertOnly: true }).then(() => undefined);

  /**
   * One-line text input. Resolves with the entered text (as typed) or null when cancelled.
   * `validate(value)` returns an error message (shown inline, blocks OK) or null; it runs on every
   * edit and on submit. OK starts disabled when the initial value is invalid (no message shown
   * until the user types or submits).
   */
  function prompt({ title, message = '', label = '', value = '', placeholder = '', okLabel = 'OK', cancelLabel = 'Cancel', validate } = {}) {
    const input = el('input', 'dlg-input');
    input.type = 'text';
    input.id = `dlg-input-${++idSeq}`;
    input.value = value == null ? '' : String(value);
    if (placeholder) input.placeholder = placeholder;
    input.spellcheck = false;
    input.setAttribute('autocomplete', 'off');
    const lab = label ? el('label', 'dlg-label', label) : null;
    if (lab) lab.htmlFor = input.id;
    else input.setAttribute('aria-label', title || 'Value');
    const error = el('p', 'dlg-error');
    error.id = `dlg-error-${idSeq}`;
    error.setAttribute('role', 'alert');
    error.hidden = true;
    input.setAttribute('aria-describedby', error.id);

    const check = () => {
      if (typeof validate !== 'function') return null;
      try {
        const r = validate(input.value);
        return r ? String(r) : null;
      } catch (e) {
        return (e && e.message) || String(e);
      }
    };
    let okEl = null;
    const show = (msg) => {
      error.textContent = msg || '';
      error.hidden = !msg;
      input.setAttribute('aria-invalid', msg ? 'true' : 'false');
      if (okEl) okEl.disabled = !!msg;
    };
    // null keeps the dialog open (the error is shown); {value} closes it.
    const submit = () => {
      const msg = check();
      show(msg);
      if (msg) { input.focus(); return null; }
      return { value: input.value };
    };
    input.addEventListener('input', () => show(check()));
    const { promise, buttons } = modal({
      title, message, body: [...(lab ? [lab] : []), input, error], fields: [input],
      buttons: [{ label: cancelLabel, value: null, cls: '' }, { label: okLabel, value: 'ok', cls: 'btn-primary' }],
      onEnter: (active) => (active === input ? submit() : undefined),
      onButton: (b) => (b.value === 'ok' ? submit() : { value: null }),
      focus: () => input,
      cancelValue: null,
    });
    okEl = buttons[buttons.length - 1];
    if (check()) okEl.disabled = true;
    if (input.value && typeof input.select === 'function') input.select();
    return promise;
  }

  /** Commit message editor (see the header). */
  function editMessage({ title, message: text, summary: s0, description: d0, okLabel = 'Save', cancelLabel = 'Cancel', note = '', validate } = {}) {
    const W = window.PLWip; // components/wip-model.js: loaded before anything opens this dialog
    const { SUMMARY_SOFT_MAX } = W;
    const init = typeof text === 'string' ? W.splitMessage(text) : { summary: s0 == null ? '' : String(s0), description: d0 == null ? '' : String(d0) };

    const summaryWrap = el('div', 'dlg-summary-wrap');
    const summary = el('input', 'dlg-input dlg-summary');
    summary.type = 'text';
    summary.id = `dlg-summary-${++idSeq}`;
    summary.value = init.summary;
    summary.placeholder = 'Summary';
    summary.spellcheck = true;
    summary.setAttribute('autocomplete', 'off');
    summary.setAttribute('aria-label', 'Commit summary');
    const counter = el('span', 'dlg-summary-count');
    counter.setAttribute('aria-hidden', 'true');
    summaryWrap.append(summary, counter);
    const desc = el('textarea', 'dlg-input dlg-description');
    desc.value = init.description;
    desc.placeholder = 'Description';
    desc.rows = 8;
    desc.spellcheck = true;
    desc.setAttribute('aria-label', 'Commit description');
    const hash = el('p', 'dlg-note dlg-hash-note', window.PLRebase.HASH_NOTE); // components/rebase-model.js
    hash.hidden = true;
    const noteEl = note ? el('p', 'dlg-note', note) : null;
    const error = el('p', 'dlg-error');
    error.id = `dlg-error-${idSeq}`;
    error.setAttribute('role', 'alert');
    error.hidden = true;
    summary.setAttribute('aria-describedby', error.id);

    const value = () => W.joinMessage(summary.value.trim(), desc.value);
    const check = () => {
      const v = value();
      if (!v.trim()) return 'Enter a commit message';
      if (typeof validate !== 'function') return null;
      try {
        const r = validate(v);
        return r ? String(r) : null;
      } catch (e) {
        return (e && e.message) || String(e);
      }
    };
    let okEl = null;
    let touched = false;
    const show = () => {
      const left = SUMMARY_SOFT_MAX - summary.value.length;
      counter.textContent = String(left);
      counter.classList.toggle('is-over', left < 0);
      hash.hidden = !/^#/m.test(value());
      const msg = check();
      error.textContent = touched && msg ? msg : '';
      error.hidden = !(touched && msg);
      summary.setAttribute('aria-invalid', touched && msg ? 'true' : 'false');
      if (okEl) okEl.disabled = !!msg;
      return msg;
    };
    const submit = () => {
      touched = true;
      if (show()) { summary.focus(); return null; }
      return { value: value() };
    };
    const edited = () => { touched = true; show(); };
    summary.addEventListener('input', edited);
    desc.addEventListener('input', edited);
    const { promise, buttons } = modal({
      title,
      wide: true,
      body: [summaryWrap, desc, hash, ...(noteEl ? [noteEl] : []), error],
      fields: [summary, desc],
      buttons: [{ label: cancelLabel, value: null, cls: '' }, { label: okLabel, value: 'ok', cls: 'btn-primary' }],
      onEnter: (active, e) => {
        if (e && util.modKey(e)) return submit();
        if (active === summary) { desc.focus(); return null; } // stay open: Enter moves to the description
        return undefined; // a newline in the description; a button presses itself
      },
      onButton: (b) => (b.value === 'ok' ? submit() : { value: null }),
      focus: () => summary,
      cancelValue: null,
    });
    okEl = buttons[buttons.length - 1];
    show();
    return promise;
  }

  /**
   * Several answers: resolves with the chosen choice's `value`, or null when cancelled. Buttons
   * show Cancel first, then the choices in order. The `primary` choice (default: the last one) is
   * focused and Enter picks the focused button; a danger choice is never focused by default (nor
   * anything in a danger dialog): Cancel is, so Enter cancels.
   */
  function choose({ title, message = '', detail = '', danger = false, choices = [], cancelLabel = 'Cancel' } = {}) {
    const buttons = [
      { label: cancelLabel, value: null, cls: '' },
      ...choices.map((c) => ({ label: c.label, value: c.value, cls: choiceClass(c) })),
    ];
    const primary = choices.findIndex((c) => c.primary);
    const pick = primary === -1 ? choices.length - 1 : primary;
    const focusIndex = danger || pick < 0 || choices[pick].danger ? 0 : pick + 1;
    const focus = (b) => b[focusIndex];
    return modal({ title, message, detail, danger, buttons, focus, cancelValue: null }).promise;
  }

  /** Up to `max` paths, one per line (made safe with displayName), then "and N more". */
  function pathListText(paths, max = 10) {
    const dn = window.Components.util.displayName;
    const lines = paths.slice(0, max).map(dn);
    if (paths.length > max) lines.push(`and ${paths.length - max} more`);
    return lines.join('\n');
  }

  /**
   * Options of the confirm for discarding the unstaged changes of `entries` ([{path, status}],
   * status '?' = untracked, which is deleted). all: the section's Discard All button.
   */
  function discardOptions(entries, { all = false } = {}) {
    const { displayName: dn, plural } = window.Components.util;
    const undoNote = `You can undo this with Undo (${Keys().keyHint('undo')}).`;
    if (entries.length === 1) {
      const e = entries[0];
      return e.status === '?'
        ? {
          title: 'Delete untracked file?',
          message: `${dn(e.path)} is untracked, so discarding it deletes the file.\n\n${undoNote}`,
          confirmLabel: 'Delete File',
          danger: true,
        }
        : {
          title: 'Discard changes?',
          message: `Discard all unstaged changes to ${dn(e.path)}?\n\n${undoNote}`,
          confirmLabel: 'Discard',
          danger: true,
        };
    }
    const u = entries.filter((e) => e.status === '?').length;
    return {
      title: all ? 'Discard all changes?' : `Discard changes to ${entries.length} files?`,
      message: `The unstaged changes to ${plural(entries.length, 'file')} will be discarded.`
        + `${u ? ` ${plural(u, 'untracked file')} will be deleted.` : ''}\n\n${undoNote}`,
      detail: pathListText(entries.map((e) => e.path).sort()),
      confirmLabel: all ? 'Discard All' : 'Discard',
      danger: true,
    };
  }

  /** The one file-level discard confirmation (WIP panel and diff view). false for no entries. */
  const confirmDiscard = (entries, opts) =>
    (entries.length ? api.confirm(discardOptions(entries, opts)) : Promise.resolve(false));

  /** Close the open dialog as if cancelled (no-op when none is open). */
  const close = () => { if (open) open.cancel(); };

  // Callers (and tests) go through `api`, so confirm can be replaced in one place.
  const api = { confirm, alert, prompt, choose, editMessage, confirmDiscard, discardOptions, pathListText, close, isOpen: () => !!open, modal };
  window.Components.dialog = api;
})();
