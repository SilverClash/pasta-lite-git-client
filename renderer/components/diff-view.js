'use strict';
// diff-view component — unified diff that replaces the graph in the centre while state.diff is set
// (it shows itself while state.centre is 'diff'; graph-view hides itself then).
//
// Rendering is virtualized: the diff is flattened into fixed-height rows (section headers, hunk
// headers, lines, "\ No newline at end of file" markers) and only the rows in view (+ overscan)
// exist in the DOM, so the line cap renders instantly. Working-copy diffs get staging controls
// (components/diff-staging.js): file / hunk buttons, line selection with a floating action bar, and
// `s` / `u` shortcuts; hunks cut short by the caps (`data-truncated`, clipped lines) refuse them.
// Pure row / spec / staging rules live in components/diff-model.js (window.PLDiff).
// A binary file gets an image preview (components/image-preview.js, docs/plans/image-preview.md) in
// place of the "Binary file — no preview" message when PLImage.wantsPreview; its header badge then
// reads `image` instead of `binary` once the preview knows (PLImage.badge). A text diff of an image
// (an SVG, a Git LFS pointer: PLImage.previewKind 'text') gets a Preview | Text switch in the header,
// one choice for the app (Components.util.storage), Preview by default; a conflicted image (a binary
// one, or a modify/delete conflict of an image file) shows its base / ours / theirs stages.
//
// Data (ops.commitDiffView / workdirDiffView): {file, sections?, fingerprint, truncated, maxLines?,
// maxLineChars?, conflict?}. `sections` (several file views, e.g. a typechange = deletion + new file)
// falls back to [file] for the older shape. `conflict` ({path, hunks:[{header, lines:[{prefix, text}]}]})
// is an unmerged path's combined diff.
// All diff text is untrusted: DOM is built with createElement + textContent only. Line content is
// shown verbatim except that bidi/invisible control characters are rendered as visible ⟨U+XXXX⟩
// markers ("Trojan Source").
(function () {
  const { el, util } = window.Components;
  const { displayName: dn, inTextField, modalOpen, short } = util;
  const { matchViewKey } = window.Components.actions; // keys.js VIEW_KEYS
  const D = window.PLDiff;
  const Img = window.PLImage;
  const { CONTROLS, CONTROLS_G, ctlLabel, sectionsOf, sectionLabel } = D;
  const ROW_H = 20;
  const OVERSCAN = 30;
  const MAX_CONTENT_W = 100000; // px: horizontal scroll range cap (ops clips very long lines)
  const VIEW_KEY = 'pl.imageView'; // a text-backed image shown as 'preview' (the default) or 'text'
  const MODIFY_DELETE = 'Modified on one side, deleted on the other — no content conflict to show';

  /** The +/- column of a diff line by its type (context lines get a space). */
  const LINE_SIGNS = Object.freeze({ add: '+', del: '-' });

  /** Where a working-folder diff comes from: Conflicted, Untracked, Staged or Unstaged. */
  function workdirWhere(d, spec) {
    if (d.data && d.data.conflict) return 'Conflicted';
    if (spec.untracked) return 'Untracked';
    return spec.staged ? 'Staged' : 'Unstaged';
  }

  /** Line text as DOM: plain text node, or text + highlighted markers for control characters. */
  function textEl(text) {
    const span = el('span', 'dv-text');
    if (!CONTROLS.test(text)) {
      span.textContent = text;
      return span;
    }
    let last = 0;
    CONTROLS_G.lastIndex = 0;
    for (let m = CONTROLS_G.exec(text); m; m = CONTROLS_G.exec(text)) {
      if (m.index > last) span.append(text.slice(last, m.index));
      const mark = el('span', 'dv-ctl', ctlLabel(m[0]));
      mark.title = 'Invisible or text-direction control character';
      span.append(mark);
      last = m.index + m[0].length;
    }
    if (last < text.length) span.append(text.slice(last));
    return span;
  }

  function badge(text, mod, title) {
    const b = el('span', `dv-badge dv-badge-${mod}`, text);
    if (title) b.title = title;
    return b;
  }

  function message(text, mod) {
    const m = el('div', `dv-message${mod ? ` dv-message-${mod}` : ''}`);
    m.append(el('div', 'dv-message-text', text));
    return m;
  }

  function truncatedText(data) {
    const n = Number(data.maxLines);
    return n > 0 ? `Diff truncated to ${n.toLocaleString('en-US')} lines` : 'Diff truncated';
  }

  function appendTail(node, l, clipped) {
    if (l.cr) {
      const cr = el('span', 'dv-cr', '␍');
      cr.title = 'CRLF line ending';
      node.append(cr);
    }
    if (clipped) {
      const c = el('span', 'dv-clipped', '…(line clipped)');
      c.title = 'This line is too long to show in full';
      node.append(c);
    }
  }

  function eofRow() {
    const node = el('div', 'dv-row dv-eof');
    const gut = el('span', 'dv-gutter');
    gut.append(el('span', 'dv-ln'), el('span', 'dv-ln'));
    node.append(gut, el('span', 'dv-sign'), el('span', 'dv-text', '\\ No newline at end of file'));
    return node;
  }

  function hunkText(r) {
    const frag = document.createDocumentFragment();
    frag.append(el('span', 'dv-hunk-text', r.hunk.header));
    if (r.hunk.truncated) {
      const t = el('span', 'dv-hunk-truncated', 'hunk truncated');
      t.title = 'Lines of this hunk were cut by the diff size limit';
      frag.append(t);
    }
    return frag;
  }

  window.Components.register('diff-view', {
    mount(root, store) {
      root.classList.add('dv');
      const header = el('header', 'dv-header');
      const bodyWrap = el('div', 'dv-body');
      root.append(header, bodyWrap);

      // Scroll container + spacer (full virtual size) + row layer.
      const scroller = el('div', 'dv-scroller');
      scroller.tabIndex = -1;
      scroller.setAttribute('role', 'region');
      scroller.setAttribute('aria-label', 'Diff content');
      const spacer = el('div', 'dv-spacer');
      scroller.append(spacer);
      // Pinned copy of the current hunk's header while its own row is scrolled past.
      const pinned = el('div', 'dv-pinned');
      pinned.hidden = true;

      // Char width of the mono font, measured once (and on first real layout).
      let charW = 0;
      function measureChar() {
        const probe = el('span', 'dv-measure', 'M'.repeat(100));
        root.append(probe);
        const w = probe.getBoundingClientRect().width / 100;
        probe.remove();
        if (w > 0) charW = w;
        return charW || 7.2;
      }

      let current = null; // {spec, data, flat, nodes: Map index->el, maxChars, canPick}
      let lastSpec = null;
      let raf = 0;
      let focusPending = false;
      let opener = null; // element focused before the diff opened (focus returns there on close)

      /** Index of the hunk at the top of the viewport (-1 when there are none). */
      function topHunk() {
        const hr = current.flat.hunkRows;
        const k = D.hunkAt(hr, Math.floor(scroller.scrollTop / ROW_H));
        return k < 0 && hr.length ? 0 : k;
      }

      const staging = window.PLDiffStaging.create({
        root, store, scroller, spacer, bodyWrap, rowH: ROW_H, current: () => current, topHunk,
      });
      const preview = window.PLImagePreview.create({ store });
      let kindBadge = null; // the shown diff's `binary` / `image` badge (PLImage.badge), updated in place
      let textView = util.storage.get(VIEW_KEY, 'preview') === 'text'; // a text-backed image shows its rows

      /** Shown only while the store's centre pane is the diff (state.centre, derived from state.diff). */
      const syncHidden = () => { root.hidden = store.state.centre !== 'diff'; };

      // ------------------------------------------------------------ header

      /** Path line ("old → new" for renames). origEntry: a staged rename / copy's status entry. */
      function headerTitle(d, file, multi, origEntry) {
        const spec = d.spec;
        const conflict = d.data && d.data.conflict;
        // A staged rename's diff may read as a new file: take the old path from the status entry.
        let t;
        if (conflict) t = { old: null, path: conflict.path || spec.file };
        else t = D.specTitle(origEntry ? { ...spec, orig: origEntry.orig } : spec, multi ? null : file);
        const old = t.old ? dn(t.old) : null;
        const path = dn(t.path);
        const pathEl = el('div', 'dv-path');
        if (old) pathEl.append(el('span', 'dv-path-old', old), el('span', 'dv-arrow', ' → '));
        const i = path.lastIndexOf('/');
        if (i >= 0) pathEl.append(el('span', 'dv-path-dir', path.slice(0, i + 1)));
        pathEl.append(el('span', 'dv-path-name', path.slice(i + 1)));
        pathEl.title = old ? `${old} → ${path}` : path;
        return pathEl;
      }

      function headerBadges(d, file, sections, origEntry) {
        const spec = d.spec;
        const badges = el('div', 'dv-badges');
        if (spec.kind === 'workdir') {
          const where = workdirWhere(d, spec);
          badges.append(badge(where, `where-${where.toLowerCase()}`));
        } else {
          badges.append(badge(short(spec.sha), 'sha', spec.sha));
        }
        if (sections.length > 1) {
          badges.append(badge('type changed', 'mode', sections.map(sectionLabel).join('\n')));
        } else if (file) {
          if (file.isNew && !spec.untracked && !origEntry) badges.append(badge('new', 'new'));
          if (file.isDeleted) badges.append(badge('deleted', 'deleted'));
          if (file.isRename || (origEntry && origEntry.status === 'R')) badges.append(badge('renamed', 'renamed'));
          if (file.isCopy || (origEntry && origEntry.status === 'C')) badges.append(badge('copied', 'renamed'));
          if (file.isBinary) {
            const kind = Img.badge(spec, d.data, store.state.imagePreview);
            kindBadge = badge(kind, kind);
            badges.append(kindBadge);
          }
          if (file.oldMode && file.newMode && file.oldMode !== file.newMode) {
            badges.append(badge(`mode ${file.oldMode} → ${file.newMode}`, 'mode'));
          }
        }
        return badges;
      }

      /** Preview | Text for a text-backed image (an SVG, a Git LFS pointer). */
      function viewToggle() {
        const g = el('div', 'seg dv-view-toggle');
        g.setAttribute('role', 'group');
        g.setAttribute('aria-label', 'Show the change as');
        for (const [view, label, title] of [['preview', 'Preview', 'Show the image before and after'], ['text', 'Text', 'Show the text diff']]) {
          const b = util.button('seg-btn dv-view-btn', label, title, () => setTextView(view === 'text'));
          b.dataset.view = view;
          b.setAttribute('aria-pressed', String(textView === (view === 'text')));
          g.append(b);
        }
        return g;
      }

      /** Switch a text-backed image between its preview and its rows (remembered for the app); focus stays on the switch. */
      function setTextView(on) {
        if (textView === on) return;
        textView = on;
        util.storage.set(VIEW_KEY, on ? 'text' : 'preview');
        const d = store.state.diff;
        if (!d) return;
        renderBody(d, false);
        const b = [...header.querySelectorAll('.dv-view-btn')].find((x) => x.dataset.view === (on ? 'text' : 'preview'));
        if (b) b.focus();
      }

      /** Stats, hunk navigation, file actions and the close button. */
      function headerRight(d) {
        const right = el('div', 'dv-header-right');
        if (Img.previewKind(d.spec, d.data) === 'text') right.append(viewToggle());
        const flat = current && current.flat;
        if (flat && flat.rows.length && !(d.data && d.data.conflict)) {
          const stats = el('span', 'dv-stats');
          stats.append(el('span', 'dv-stat-add', `+${flat.adds}`), el('span', 'dv-stat-del', `−${flat.dels}`));
          right.append(stats);
        }
        if (flat && flat.hunkRows.length > 1) {
          const nav = el('div', 'dv-nav');
          nav.append(
            util.button('dv-icon-btn', '↑', 'Previous hunk (p)', () => jumpHunk(-1)),
            el('span', 'dv-hunk-count', `${flat.hunkRows.length} hunks`),
            util.button('dv-icon-btn', '↓', 'Next hunk (n)', () => jumpHunk(1)),
          );
          right.append(nav);
        }
        right.append(staging.fileActions(d));
        const close = util.button('dv-close', '×', 'Close diff (Esc)', () => store.actions.closeDiff());
        close.setAttribute('aria-label', 'Close diff');
        right.append(close);
        return right;
      }

      function renderHeader(d) {
        kindBadge = null;
        const sections = sectionsOf(d.data);
        const file = sections[0] || null;
        const multi = sections.length > 1;
        const origEntry = d.spec.kind === 'workdir' ? D.origEntry(d.spec, store.state.status) : null;
        const left = el('div', 'dv-title');
        left.append(headerTitle(d, file, multi, origEntry), headerBadges(d, file, sections, origEntry));
        header.replaceChildren(left, headerRight(d));
      }

      // ------------------------------------------------------------ body

      /** Display text of a line, clipped to what the capped scroll width can show. */
      function lineText(l) {
        const max = current.maxChars;
        return l.text.length > max ? { text: l.text.slice(0, max), clipped: true } : { text: l.text, clipped: !!l.clipped };
      }

      function lineRow(l) {
        const node = el('div', `dv-row dv-${l.type}`);
        const sign = LINE_SIGNS[l.type] || ' ';
        const gut = el('span', 'dv-gutter');
        gut.append(el('span', 'dv-ln', l.oldNo == null ? '' : String(l.oldNo)), el('span', 'dv-ln', l.newNo == null ? '' : String(l.newNo)));
        const { text, clipped } = lineText(l);
        node.append(gut, el('span', 'dv-sign', sign), textEl(text));
        appendTail(node, l, clipped);
        node.dataset.type = l.type;
        return node;
      }

      function conflictRow(l) {
        const node = el('div', `dv-row dv-cline ${D.conflictClass(l)}`);
        const gut = el('span', 'dv-gutter dv-gutter-prefix');
        gut.append(el('span', 'dv-prefix', l.prefix || ''));
        const { text, clipped } = lineText(l);
        node.append(gut, textEl(text));
        appendTail(node, l, clipped);
        return node;
      }

      function hunkHeaderEl(r) {
        const node = el('div', 'dv-row dv-hunk');
        node.dataset.hunk = String(r.index);
        node.dataset.section = String(r.section);
        if (r.hunk.truncated) node.dataset.truncated = '1';
        const gut = el('span', 'dv-gutter dv-gutter-hunk');
        gut.append(hunkText(r));
        node.append(gut, staging.hunkActions(r));
        return node;
      }

      const ROW_BUILDERS = {
        hunk: hunkHeaderEl,
        line: (r) => lineRow(r.line),
        cline: (r) => conflictRow(r.line),
        section: (r) => el('div', 'dv-row dv-section', r.label),
        note: (r) => el('div', 'dv-row dv-note', r.text),
        eof: eofRow,
      };

      function buildRow(r, i) {
        const make = ROW_BUILDERS[r.t];
        if (!make) throw new Error(`diff-view: unknown row type ${r.t}`);
        const node = make(r);
        node.style.top = `${i * ROW_H}px`;
        node.dataset.row = String(i);
        if (r.t === 'line') staging.decorateRow(node, i);
        return node;
      }

      function paint() {
        raf = 0;
        if (!current || !current.flat) return;
        const { rows } = current.flat;
        const top = scroller.scrollTop;
        const h = scroller.clientHeight || 800;
        const a = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
        const b = Math.min(rows.length, Math.ceil((top + h) / ROW_H) + OVERSCAN);
        const nodes = current.nodes;
        for (const [i, n] of nodes) {
          if (i < a || i >= b) {
            n.remove();
            nodes.delete(i);
          }
        }
        const frag = document.createDocumentFragment();
        for (let i = a; i < b; i++) {
          if (nodes.has(i)) continue;
          const n = buildRow(rows[i], i);
          nodes.set(i, n);
          frag.append(n);
        }
        if (frag.childNodes.length) spacer.append(frag);
        updatePinned(top);
      }

      /** Show the header of the hunk containing the first visible row when its own header is off-screen. */
      function updatePinned(top) {
        const hr = current.flat.hunkRows;
        const k = D.hunkAt(hr, Math.floor(top / ROW_H));
        const show = k >= 0 && top > hr[k] * ROW_H + 0.5;
        if (!show) {
          pinned.hidden = true;
          pinned.dataset.hunk = '';
          return;
        }
        if (pinned.dataset.hunk !== String(k)) {
          const r = current.flat.rows[hr[k]];
          pinned.replaceChildren(hunkText(r), staging.hunkActions(r));
          pinned.dataset.hunk = String(k);
        }
        pinned.hidden = false;
      }

      function schedule() {
        if (!raf) raf = requestAnimationFrame(paint);
      }
      scroller.addEventListener('scroll', schedule, { passive: true });
      const ro = new ResizeObserver(() => { if (current && current.flat) schedule(); });
      ro.observe(scroller);

      function jumpHunk(dir) {
        if (!current || !current.flat) return;
        const hr = current.flat.hunkRows;
        if (!hr.length) return;
        const pos = scroller.scrollTop / ROW_H;
        const target = dir > 0 ? hr.find((r) => r > pos + 0.5) : [...hr].reverse().find((r) => r < pos - 0.5);
        if (target === undefined) return;
        scroller.scrollTop = target * ROW_H;
        schedule();
      }

      /**
       * Lay out the body for a loaded result: sets current.flat / current.maxChars and the
       * scroller's sizes when rows are shown, and returns the body's elements.
       */
      function layoutBody(d) {
        const data = d.data;
        const parts = [];
        const conflict = data && data.conflict;
        const sections = sectionsOf(data);
        const noticeEl = staging.noticePart();
        if (noticeEl) parts.push(noticeEl);
        if (data && data.truncated) parts.push(el('div', 'dv-banner', truncatedText(data)));
        const note = staging.notePart(d);
        if (note) parts.push(note);
        const kind = Img.previewKind(d.spec, data);
        if (kind === 'conflict') {
          parts.push(el('div', 'dv-banner dv-banner-conflict', 'Conflicted image — the base, ours and theirs versions. Keep one side or mark the file resolved in the WIP panel.'));
          parts.push(preview.attach(d, conflict.isBinary ? 'Binary file — no preview' : MODIFY_DELETE));
          return parts;
        }
        if (conflict) {
          parts.push(el('div', 'dv-banner dv-banner-conflict', 'Conflicted file — combined diff against both sides. Keep one side or mark the file resolved in the WIP panel.'));
          if (!conflict.hunks || !conflict.hunks.length) {
            parts.push(message(MODIFY_DELETE));
            return parts;
          }
        } else if (!sections.length) {
          parts.push(message('No changes'));
          return parts;
        } else if (kind === 'binary' || (kind === 'text' && !textView)) {
          parts.push(preview.attach(d, kind === 'text' ? 'No image to preview — Text shows the change' : D.emptyText(sections[0])));
          return parts;
        } else if (sections.length === 1 && !sections[0].hunks.length) {
          parts.push(message(D.emptyText(sections[0]), sections[0].isBinary ? 'binary' : null));
          return parts;
        }
        const flat = D.flatten(sections, conflict);
        current.flat = flat;
        const cw = charW || measureChar();
        current.maxChars = Math.max(200, Math.floor(MAX_CONTENT_W / cw));
        const digits = Math.max(3, String(flat.maxNo).length);
        const lnW = Math.ceil(digits * cw + 12);
        const gutterW = conflict ? Math.ceil(Math.max(2, flat.prefixW) * cw + 16) : lnW * 2 + 18;
        const contentW = Math.min(MAX_CONTENT_W, Math.ceil(gutterW + Math.min(flat.maxCols, current.maxChars + 18) * cw + 40));
        scroller.style.setProperty('--dv-ln-w', `${lnW}px`);
        scroller.style.setProperty('--dv-prefix-w', `${gutterW}px`);
        spacer.style.height = `${flat.rows.length * ROW_H}px`;
        spacer.style.width = `${contentW}px`;
        scroller.classList.toggle('is-conflict', !!conflict);
        const inner = el('div', 'dv-viewport');
        inner.append(scroller, pinned, staging.selBar);
        parts.push(inner);
        return parts;
      }

      function renderBody(d, keepScroll) {
        let prevTop = keepScroll ? scroller.scrollTop : 0;
        const prevLeft = keepScroll ? scroller.scrollLeft : 0;
        staging.beforeRender(d, keepScroll);
        // canPick (hunk / line actions possible) is decided once per render (PLDiff.hunkDataOk).
        const canPick = D.hunkDataOk(d.spec, d.data, store.state.status);
        current = { spec: d.spec, data: d.data, flat: null, nodes: new Map(), maxChars: Infinity, canPick };
        preview.detach(); // layoutBody attaches it again when this diff has one
        spacer.replaceChildren();
        pinned.hidden = true;
        pinned.dataset.hunk = '';
        let parts;
        if (d.loading && !d.data) parts = [message('Loading diff…', 'loading')];
        else if (d.error) parts = [message(d.error, 'error')];
        else parts = layoutBody(d);
        scroller.tabIndex = current.flat ? 0 : -1;
        bodyWrap.replaceChildren(...parts);
        renderHeader(d);
        if (current.flat) {
          // After our own write, put the acted-on hunk slot (now usually the next hunk) back
          // where it was on screen instead of keeping a raw offset that may land elsewhere.
          const top = staging.restoreTop(d, keepScroll);
          if (top !== null) prevTop = top;
          scroller.scrollTop = prevTop;
          scroller.scrollLeft = prevLeft;
          paint();
        }
        staging.afterRender();
      }

      function close() {
        current = null;
        lastSpec = null;
        kindBadge = null;
        preview.detach();
        staging.reset();
        spacer.replaceChildren();
        bodyWrap.replaceChildren();
        header.replaceChildren();
        scroller.tabIndex = -1;
        const hadFocus = root.contains(document.activeElement);
        syncHidden();
        // Hand focus back to where the diff was opened from (e.g. the details file row).
        if (hadFocus || document.activeElement === document.body) {
          const back = opener && opener.isConnected ? opener : null;
          if (back) back.focus({ preventScroll: true });
        }
        opener = null;
        focusPending = false;
      }

      function update(state) {
        const d = state.diff;
        if (!d) {
          if (current || !root.hidden) close();
          return;
        }
        const wasOpen = !!current;
        if (!wasOpen && !root.contains(document.activeElement)) opener = document.activeElement;
        syncHidden();
        // A reload of the same file (after a refresh, or the spec re-made by the store when an
        // untracked file became tracked) keeps the scroll position and focus.
        const same = D.sameSpec(lastSpec, d.spec);
        // Keep showing the previous content while an in-place reload is loading.
        if (same && d.loading && current && current.data) return;
        if (!same) focusPending = true;
        lastSpec = d.spec;
        renderBody(d, same);
        // A newly opened (or switched) diff takes keyboard focus once its rows exist, so
        // arrows/PgUp/PgDn scroll it (focus is never moved by a background reload).
        if (focusPending && !d.loading) {
          focusPending = false;
          if (current.flat) scroller.focus({ preventScroll: true });
        }
      }

      function onKey(e) {
        if (!store.state.diff || root.hidden || e.defaultPrevented) return;
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        if (inTextField(e) || modalOpen()) return;
        if (staging.onKey(e) || preview.onKey(e)) return;
        const k = matchViewKey(e, 'diff');
        if (k && k.id === 'closeDiff') {
          e.preventDefault();
          store.actions.closeDiff();
        } else if (k && (k.id === 'nextHunk' || k.id === 'prevHunk')) {
          e.preventDefault();
          jumpHunk(k.id === 'nextHunk' ? 1 : -1);
        }
      }
      document.addEventListener('keydown', onKey);

      const unsub = store.subscribe(['diff'], update);
      // The preview redraws itself; only the header's binary / image badge follows it here.
      const unsubPreview = store.subscribe(['imagePreview'], (s) => {
        if (!kindBadge || !s.diff || !s.diff.data) return;
        const kind = Img.badge(s.diff.spec, s.diff.data, s.imagePreview);
        if (kindBadge.textContent === kind) return;
        kindBadge.textContent = kind;
        kindBadge.className = `dv-badge dv-badge-${kind}`;
      });
      const unsubBusy = store.subscribe(['busy'], staging.syncBusy);
      update(store.state);
      return () => {
        unsub();
        unsubBusy();
        unsubPreview();
        staging.dispose();
        preview.dispose();
        store.actions.releaseImagePreview();
        ro.disconnect();
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        document.removeEventListener('keydown', onKey);
        header.remove(); // a remount starts from an empty region
        bodyWrap.remove();
        root.classList.remove('dv', 'is-busy');
      };
    },
  });
})();
