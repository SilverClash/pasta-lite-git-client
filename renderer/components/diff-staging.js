'use strict';
// Staging controller of the diff view (plain script; exposes window.PLDiffStaging).
//
// Workdir diffs only. Unstaged / untracked: Stage + Discard (hunk, lines, file); staged:
// Unstage. Hunk and line actions need the view's fingerprint (exactly one fully parsed text
// section of a regular file, PLDiff.hunkDataOk) and a hunk that is complete (not truncated, no
// clipped line): the selection is [{hunk, lines?}] with indices into data.sections[0].hunks[h].lines,
// which are hunks.js's own parse of the same patch. Every hunk / line call sends {fingerprint}, so
// a file that changed since it was shown is refused ('stale') and nothing is touched. File-level
// discards re-check the status entry after the confirm instead. The writes, their confirms and those
// checks are the working-tree flows (flows-worktree.js: stage, unstage, discard, stageSelection,
// unstageSelection, discardSelection), run through Components.actions.runFlow with this view's
// in-flight hooks (`ui`); this controller keeps the selection, the focus, the scroll and the notice.
//
// Line selection: gutter drag / click / Shift-range with the mouse; with the diff focused, ↑/↓ move
// a line cursor over the selectable lines, Space toggles the line under it, Shift+↑/↓ extend.
// `s` / `u` act on the selection, else on the cursor's (or focused, or top) hunk.
//
// One write at a time: `acting` is set before the confirm (the flow's begin hook) and kept after
// success until the reloaded diff (a new fingerprint) is rendered, or HOLD_MS at most.
(function () {
  const { el, util } = window.Components;
  const { plural } = util;
  const D = window.PLDiff;
  const W = window.PLWip;
  const runFlow = (d, store) => window.Components.actions.runFlow(d, store);
  const diffKey = (e) => window.Components.actions.matchViewKey(e, 'diff'); // keys.js VIEW_KEYS
  /** The working-tree flow of a hunk / line action ('stage' -> 'stageSelection', …: PLDiff.SELECTION_OPS). */
  const selectionFlow = (kind) => D.SELECTION_OPS[kind];
  const TOO_LARGE = 'Too large to stage by hunk — use Stage File';
  const HOLD_MS = 2500;

  /**
   * create({root, store, scroller, spacer, bodyWrap, rowH, current, topHunk}):
   *   current()  the diff view's {spec, data, flat, nodes, canPick} (or null)
   *   topHunk()  index of the hunk at the top of the viewport (-1 when none)
   * Returns the hooks the diff view calls while rendering (see the return value).
   */
  function create({ root, store, scroller, spacer, bodyWrap, rowH: ROW_H, current: cur, topHunk }) {
    let picked = new Set(); // flat row indices of the selected add/del lines
    let anchorRow = -1; // last clicked / toggled line (Shift extends from here)
    let cursorRow = -1; // keyboard line cursor
    let extendBase = null; // picks before a Shift+arrow extension started
    let drag = null; // {base, add, from}
    let clickToggle = null; // the line the first click of a possible double-click toggled
    let notice = null; // inline banner text (stale selection)
    let acting = false; // our own write is in flight (the 'busy' event follows asynchronously)
    let holdFp; // fingerprint shown when our write succeeded: `acting` lasts until it changes
    let holdTimer = 0;
    let pendingScroll = null; // {hunk, dy, fp, at}: where to put the acted-on hunk after the reload
    let lastFp; // fingerprint of the data currently shown

    const canAct = () => { const c = cur(); return !!(c && c.flat && c.canPick); };
    const mode = () => { const c = cur(); return c ? D.actMode(c.spec, c.data) : null; };
    const pickable = (i) => { const c = cur(); return !!c && D.isPickable(c.flat, i, c.canPick); };
    const isOff = () => acting || !!store.state.busy;

    // ------------------------------------------------------------ in-flight state

    function release() {
      acting = false;
      holdFp = undefined;
      clearTimeout(holdTimer);
      holdTimer = 0;
      syncBusy();
    }

    function hold(fp) {
      holdFp = fp;
      clearTimeout(holdTimer);
      holdTimer = setTimeout(release, HOLD_MS);
    }

    function syncBusy() {
      const off = isOff();
      root.classList.toggle('is-busy', off);
      for (const b of root.querySelectorAll('button.dv-act')) b.disabled = off;
    }

    // ------------------------------------------------------------ buttons

    function actBtn(label, mod, title, fn) {
      const b = el('button', `dv-act dv-act-${mod}`, label);
      b.type = 'button';
      if (title) b.title = title;
      b.disabled = isOff();
      b.addEventListener('mousedown', (e) => e.stopPropagation()); // not a line-selection drag
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        fn();
      });
      return b;
    }

    /** Buttons of a hunk header (row or pinned copy); empty (hidden) where not applicable. */
    function hunkActions(r) {
      const actions = el('span', 'dv-actions dv-hunk-actions');
      actions.dataset.hunk = String(r.index);
      actions.dataset.section = String(r.section);
      if (r.section !== 0 || !canAct()) return actions;
      if (cur().flat.blocked[r.index]) {
        const na = el('span', 'dv-hunk-na', 'Too large to stage by hunk');
        na.title = TOO_LARGE;
        actions.append(na);
        return actions;
      }
      if (mode() === 'staged') {
        actions.append(actBtn('Unstage Hunk', 'unstage', 'Unstage this hunk (u)', () => actOnHunk('unstage', r.index)));
      } else {
        actions.append(
          actBtn('Discard Hunk', 'discard', 'Discard this hunk from the working copy', () => actOnHunk('discard', r.index)),
          actBtn('Stage Hunk', 'stage', 'Stage this hunk (s)', () => actOnHunk('stage', r.index)),
        );
      }
      return actions;
    }

    /** File-level Stage / Unstage / Discard (header). */
    function fileActions(d) {
      const box = el('div', 'dv-actions dv-file-actions');
      const spec = d.spec;
      if (spec.kind !== 'workdir' || !d.data || d.data.conflict) return box;
      if (spec.staged) {
        box.append(actBtn('Unstage File', 'unstage', 'Unstage all changes of this file', () => {
          const entry = D.entryOf(spec, store.state.status);
          runWrite(spec, 'unstage', [entry ? W.unstagePathsFor(entry) : [spec.file]]);
        }));
        return box;
      }
      box.append(
        actBtn(spec.untracked ? 'Delete File' : 'Discard File', 'discard',
          spec.untracked ? 'Delete this untracked file' : 'Discard all unstaged changes of this file', () => discardFile(spec)),
        actBtn('Stage File', 'stage', 'Stage the whole file', () => runWrite(spec, 'stage', [[spec.file]])),
      );
      return box;
    }

    // ------------------------------------------------------------ actions

    function discardFile(spec) {
      const entry = D.entryOf(spec, store.state.status);
      if (!entry) { // gone from the unstaged list: the view is out of date
        store.actions.toast(new Error(W.FILE_CHANGED));
        return;
      }
      // The flow confirms and re-checks the entry after the confirm (PLFlows.discard).
      runWrite(spec, 'discard', [[{ path: entry.path, status: entry.status }], {}]);
    }

    function actOnHunk(kind, h) {
      const c = cur();
      if (!canAct() || c.flat.blocked[h] || !D.sectionsOf(c.data)[0].hunks[h]) return;
      const spec = c.spec;
      // A discard asks first (PLFlows.discardSelection).
      runWrite(spec, selectionFlow(kind), [{ file: spec.file, selection: [{ hunk: h }], fingerprint: c.data.fingerprint }], { hunk: h });
    }

    function actOnLines(kind) {
      if (!picked.size || !canAct()) return;
      const c = cur();
      const spec = c.spec;
      const sel = D.selectionPayload(picked, c.flat.rows);
      // A discard asks first (PLFlows.discardSelection).
      runWrite(spec, selectionFlow(kind), [{ file: spec.file, selection: sel, fingerprint: c.data.fingerprint }], { hunk: sel[0].hunk, lines: true });
    }

    /**
     * Run working-tree flow `flow` with `args` (the selection + fingerprint are fixed before any
     * confirm dialog, so a diff reloaded meanwhile makes the call fail as stale instead of acting on
     * other lines) and this view's in-flight hooks. The flow toasts errors; 'stale' is explained here,
     * inline. opts: {hunk (scroll anchor), lines (clear the line selection on success)}.
     */
    async function runWrite(spec, flow, args, { hunk = null, lines = false } = {}) {
      if (isOff()) return false;
      const c0 = cur();
      const fp = c0 && c0.data ? c0.data.fingerprint : null;
      let hadFocus = false;
      let sent = false;
      const ui = {
        begin: () => { acting = true; syncBusy(); },
        isCurrent: () => { const c = cur(); return !!c && D.sameSpec(c.spec, spec); },
        sending: () => {
          sent = true;
          setNotice(null);
          hadFocus = root.contains(document.activeElement);
          rememberScroll(hunk, fp);
        },
        hold: () => {
          if (lines) clearPicked(true);
          hold(fp);
        },
        end: release,
        stale: () => {
          pendingScroll = null;
          setNotice('The file changed — diff reloaded, please retry');
        },
        fail: () => { pendingScroll = null; },
      };
      const ok = await runFlow({ flow, args: [...args, ui] }, store);
      // The clicked button is rebuilt by the reload: keep keyboard focus in the diff.
      const c = cur();
      if (sent && c && c.flat && (hadFocus || document.activeElement === document.body)) scroller.focus({ preventScroll: true });
      return ok;
    }

    function rememberScroll(hunk, fp) {
      const c = cur();
      if (!c || !c.flat) return;
      const hr = c.flat.hunkRows;
      const h = hunk == null ? topHunk() : hunk;
      if (h < 0 || h >= hr.length) return;
      pendingScroll = { hunk: h, dy: Math.max(0, hr[h] * ROW_H - scroller.scrollTop), fp, at: Date.now() };
    }

    /** The hunk for `s` / `u`: the line cursor's, else the one holding focus, else the top one. */
    function focusedHunk() {
      const c = cur();
      if (!c || !c.flat) return null;
      if (cursorRow >= 0 && pickable(cursorRow)) return D.hunkAt(c.flat.hunkRows, cursorRow);
      const a = document.activeElement;
      const holder = a && root.contains(a) ? a.closest('[data-hunk]') : null;
      if (holder && holder.dataset.hunk !== '') return Number(holder.dataset.hunk);
      const k = topHunk();
      return k < 0 ? null : k;
    }

    // ------------------------------------------------------------ banner + selection bar

    // Inline banner for a stale selection (kept across the reload it triggers).
    const noticeEl = el('div', 'dv-banner dv-banner-stale');
    function setNotice(text) {
      notice = text;
      noticeEl.replaceChildren();
      if (!text) {
        noticeEl.remove();
        return;
      }
      const x = el('button', 'dv-banner-close', '×');
      x.type = 'button';
      x.title = 'Dismiss';
      x.setAttribute('aria-label', 'Dismiss');
      x.addEventListener('click', () => setNotice(null));
      noticeEl.append(el('span', 'dv-banner-text', text), x);
      noticeEl.setAttribute('role', 'status');
      const c = cur();
      if (!noticeEl.isConnected && c && c.data) bodyWrap.prepend(noticeEl);
    }

    // Floating bar for the line selection.
    const selBar = el('div', 'dv-selbar');
    selBar.hidden = true;
    selBar.setAttribute('role', 'toolbar');
    selBar.setAttribute('aria-label', 'Selected lines');
    selBar.addEventListener('mousedown', (e) => e.stopPropagation());

    function updateBar() {
      const m = mode();
      if (!picked.size || !m || !canAct()) {
        selBar.hidden = true;
        selBar.replaceChildren();
        return;
      }
      const lines = plural(picked.size, 'line');
      const clear = el('button', 'dv-act dv-act-clear', 'Clear');
      clear.type = 'button';
      clear.title = 'Clear the line selection (Esc)';
      clear.addEventListener('click', () => clearPicked(true));
      const btns = m === 'staged'
        ? [actBtn(`Unstage ${lines}`, 'unstage', 'Unstage the selected lines (u)', () => actOnLines('unstage'))]
        : [actBtn(`Discard ${lines}`, 'discard', 'Discard the selected lines from the working copy', () => actOnLines('discard')),
          actBtn(`Stage ${lines}`, 'stage', 'Stage the selected lines (s)', () => actOnLines('stage'))];
      selBar.replaceChildren(el('span', 'dv-selbar-count', `${lines} selected`), clear, ...btns);
      selBar.hidden = false;
    }

    // ------------------------------------------------------------ line selection

    function syncPicked() {
      const c = cur();
      if (c && c.nodes) {
        for (const [i, n] of c.nodes) {
          if (!n.classList.contains('is-pickable')) continue;
          n.classList.toggle('is-picked', picked.has(i));
          n.classList.toggle('is-cursor', i === cursorRow);
        }
      }
      updateBar();
    }

    function clearPicked(render) {
      picked = new Set();
      anchorRow = -1;
      extendBase = null;
      if (drag) endDrag();
      if (render) syncPicked();
    }

    function toggle(i) {
      picked = new Set(picked);
      if (picked.has(i)) picked.delete(i);
      else picked.add(i);
      anchorRow = i;
      cursorRow = i;
      extendBase = null;
      syncPicked();
    }

    // Mouse: press on a line's gutter / sign and drag to select a range (starting on a selected
    // line deselects instead); Shift-press extends from the last clicked line. A plain click on
    // the text toggles the line too, while a text drag (or a double-click) still selects text.
    function rowAt(clientY) {
      const rect = spacer.getBoundingClientRect();
      return Math.max(0, Math.min(cur().flat.rows.length - 1, Math.floor((clientY - rect.top) / ROW_H)));
    }

    function applyDrag(to) {
      const next = new Set(drag.base);
      const [a, b] = drag.from <= to ? [drag.from, to] : [to, drag.from];
      for (let k = a; k <= b; k++) {
        if (!pickable(k)) continue;
        if (drag.add) next.add(k);
        else next.delete(k);
      }
      picked = next;
      syncPicked();
    }

    function onDragMove(e) {
      const c = cur();
      if (!drag || !c || !c.flat) return;
      const sr = scroller.getBoundingClientRect();
      if (e.clientY < sr.top + 8) scroller.scrollTop -= ROW_H;
      else if (e.clientY > sr.bottom - 8) scroller.scrollTop += ROW_H;
      applyDrag(rowAt(e.clientY));
    }

    function endDrag() {
      drag = null;
      document.removeEventListener('mousemove', onDragMove);
      document.removeEventListener('mouseup', endDrag);
    }

    const rowIndexOf = (target) => {
      const rowEl = target.closest('.dv-row');
      return rowEl ? Number(rowEl.dataset.row) : -1;
    };

    spacer.addEventListener('mousedown', (e) => {
      const c = cur();
      if (e.button !== 0 || !c || !c.flat || e.target.closest('button')) return;
      const i = rowIndexOf(e.target);
      if (!pickable(i)) return;
      const inGutter = !!e.target.closest('.dv-gutter, .dv-sign');
      if (!inGutter && !e.shiftKey) return; // plain press on text: text selection / 'click' toggle
      e.preventDefault();
      scroller.focus({ preventScroll: true });
      extendBase = null;
      if (e.shiftKey && anchorRow >= 0 && pickable(anchorRow)) drag = { base: new Set(picked), add: true, from: anchorRow };
      else {
        drag = { base: new Set(picked), add: !picked.has(i), from: i };
        anchorRow = i;
      }
      cursorRow = i;
      applyDrag(i);
      document.addEventListener('mousemove', onDragMove);
      document.addEventListener('mouseup', endDrag);
    });

    spacer.addEventListener('click', (e) => {
      clickToggle = null;
      const c = cur();
      if (e.button !== 0 || e.shiftKey || e.detail > 1 || !c || !c.flat) return;
      if (e.target.closest('.dv-gutter, .dv-sign, button')) return;
      const s = window.getSelection();
      if (s && !s.isCollapsed) return; // the user selected text
      const i = rowIndexOf(e.target);
      if (!pickable(i)) return;
      toggle(i);
      clickToggle = i;
    });

    // A double-click on the text selects a word: undo the toggle its first click made.
    spacer.addEventListener('dblclick', (e) => {
      const t = clickToggle;
      clickToggle = null;
      if (t === null || e.target.closest('.dv-gutter, .dv-sign, button')) return;
      if (rowIndexOf(e.target) === t && pickable(t)) toggle(t);
    });

    // Keyboard line cursor (the diff scroller has focus).
    function inView(i) {
      const y = i * ROW_H;
      return y >= scroller.scrollTop && y + ROW_H <= scroller.scrollTop + scroller.clientHeight;
    }

    function ensureVisible(i) {
      const y = i * ROW_H;
      if (y < scroller.scrollTop + ROW_H) scroller.scrollTop = Math.max(0, y - ROW_H); // below the pinned hunk header
      else if (y + ROW_H > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = y + ROW_H - scroller.clientHeight;
    }

    /** ↑/↓ (dir ±1): move the line cursor; extend: Shift, grow the selection from the anchor. */
    function moveCursor(dir, extend) {
      const c = cur();
      const from = cursorRow >= 0 && pickable(cursorRow) && inView(cursorRow) ? cursorRow : -1;
      let next;
      if (from >= 0) next = D.nextPickable(c.flat, from, dir, c.canPick);
      else {
        const top = Math.floor(scroller.scrollTop / ROW_H);
        const bottom = Math.floor((scroller.scrollTop + scroller.clientHeight - 1) / ROW_H);
        next = dir > 0 ? D.nextPickable(c.flat, top - 1, 1, c.canPick) : D.nextPickable(c.flat, bottom + 1, -1, c.canPick);
      }
      if (next < 0) return false; // no selectable line that way: the key scrolls as usual
      if (extend) {
        if (!extendBase) {
          extendBase = new Set(picked);
          anchorRow = from >= 0 ? from : next;
        }
        const [a, b] = anchorRow <= next ? [anchorRow, next] : [next, anchorRow];
        const n = new Set(extendBase);
        for (let k = a; k <= b; k++) if (pickable(k)) n.add(k);
        picked = n;
      } else extendBase = null;
      cursorRow = next;
      ensureVisible(next);
      syncPicked();
      return true;
    }

    /** Focus is in the diff (or nowhere): `s` / `u` may act on it. */
    const focusInDiff = () => {
      const a = document.activeElement;
      return !a || a === document.body || root.contains(a);
    };

    /**
     * Staging keys (the diff view has already dropped modified keys, editable targets and open
     * dialogs). true = handled (default prevented).
     */
    function onKey(e) {
      if (e.key === 'Escape') {
        if (drag) endDrag();
        if (!picked.size) return false; // Esc then closes the diff
        e.preventDefault();
        clearPicked(true); // first Esc clears the line selection
        return true;
      }
      const k = diffKey(e);
      if (k && (k.id === 'stageHunk' || k.id === 'unstageHunk')) {
        const want = k.id === 'stageHunk' ? 'unstaged' : 'staged';
        if (mode() !== want || !focusInDiff()) return false;
        e.preventDefault();
        if (e.repeat) return true;
        if (picked.size) actOnLines(want === 'unstaged' ? 'stage' : 'unstage');
        else {
          const h = focusedHunk();
          if (h != null) actOnHunk(want === 'unstaged' ? 'stage' : 'unstage', h);
        }
        return true;
      }
      if (document.activeElement !== scroller || !canAct()) return false;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!moveCursor(e.key === 'ArrowDown' ? 1 : -1, e.shiftKey)) return false;
        e.preventDefault();
        return true;
      }
      if (e.key === ' ' && !e.shiftKey && cursorRow >= 0 && pickable(cursorRow) && inView(cursorRow)) {
        e.preventDefault();
        if (!e.repeat) toggle(cursorRow);
        return true;
      }
      return false;
    }

    // ------------------------------------------------------------ render hooks

    /**
     * Before a render of `d`: the line selection indexes this exact diff, so drop it when the
     * diff changes (new fingerprint) or another file opens; a stale notice / scroll anchor
     * belongs to one file. A new fingerprint also ends our write's in-flight hold.
     */
    function beforeRender(d, keepScroll) {
      const fp = d.data ? d.data.fingerprint : null;
      if (!keepScroll || fp == null || fp !== lastFp) {
        clearPicked(false);
        cursorRow = -1;
      }
      if (!keepScroll) {
        notice = null;
        pendingScroll = null;
      }
      if (acting && holdFp !== undefined && fp !== holdFp) release();
      lastFp = fp;
    }

    /** After our own write, the scrollTop that puts the acted-on hunk slot back where it was, or null. */
    function restoreTop(d, keepScroll) {
      const ps = pendingScroll;
      const c = cur();
      if (!keepScroll || !ps || !d.data || d.data.fingerprint === ps.fp || !c || !c.flat) return null;
      pendingScroll = null;
      const hr = c.flat.hunkRows;
      if (!hr.length || Date.now() - ps.at >= 15000) return null;
      return Math.max(0, hr[Math.min(ps.hunk, hr.length - 1)] * ROW_H - ps.dy);
    }

    /** Selection classes of a freshly built line row. */
    function decorateRow(node, i) {
      if (!pickable(i)) return;
      node.classList.add('is-pickable');
      if (picked.has(i)) node.classList.add('is-picked');
      if (i === cursorRow) node.classList.add('is-cursor');
    }

    /** The diff closed. */
    function reset() {
      clearPicked(false);
      cursorRow = -1;
      notice = null;
      pendingScroll = null;
      lastFp = undefined;
      release();
    }

    return {
      hunkActions,
      fileActions,
      /** Banner elements for the body top: the stale notice (when set). */
      noticePart: () => (notice ? noticeEl : null),
      /** Why hunk / line staging is unavailable for `d`, as an element, or null. */
      notePart(d) {
        const why = D.stagingNote(d.spec, d.data, store.state.status);
        return why ? el('div', 'dv-stage-note', why) : null;
      },
      selBar,
      beforeRender,
      restoreTop,
      decorateRow,
      afterRender() {
        updateBar();
        syncBusy();
      },
      syncBusy,
      onKey,
      reset,
      dispose() {
        endDrag();
        clearTimeout(holdTimer);
        holdTimer = 0;
      },
    };
  }

  window.PLDiffStaging = { create };
})();
