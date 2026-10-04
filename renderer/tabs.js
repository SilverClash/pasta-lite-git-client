'use strict';
// Tab strip (renderer/tabs.html): one tab per open repository, drawn from main's
// 'tabs-changed' state (window.tabsApi, preload-tabs.js). Main owns the tabs: every action here
// (activate, close, new, move, context menu) is a call, and the strip redraws from the event that
// follows. All text is set with textContent. Each tab shows a branch icon, or a tree icon when
// main flags its repo a linked worktree (t.linked; its title is then main's 'project · folder').
//
// Mouse: click (press) shows a tab, the × or a middle click closes it, dragging reorders, right
// click opens its menu, "+" adds a New Tab. Keyboard (role tablist / tab, roving tabindex): Left /
// Right / Home / End move the focus, Enter / Space show the focused tab (the focus stays here),
// Delete / Backspace close it, the menu key / Shift+F10 open its menu. ⌘T / ⌘W / Ctrl+Tab and
// ⌘1–⌘9 are main's menu accelerators, from any page.
(() => {
  const api = window.tabsApi;
  const $ = (id) => document.getElementById(id);
  const tablist = $('tablist');
  const newBtn = $('new-tab');
  const SVG = 'http://www.w3.org/2000/svg';
  const DRAG_PX = 4; // pointer travel before a press on a tab becomes a drag

  let tabs = []; // [{id, title, root, active, linked, tooltip, busy}] from main
  let focusId = null; // the tab holding the roving tabindex
  let drag = null; // {id, el, startX, pointerId, active, marker, index}
  const els = new Map(); // tab id -> its element (kept across redraws: focus and hover survive)

  document.documentElement.classList.toggle('is-mac', !!api.isMac);
  const mod = api.isMac ? '⌘' : 'Ctrl+';
  newBtn.title = `New Tab (${mod}T)`;

  /**
   * A tab's icon: the branch, or for a linked worktree (t.linked, main's repo.linkedWorktree) a
   * tree, the sidebar's worktree icon from renderer/icons.js (tabs.html loads it), drawn a little
   * bolder at the tab's 14px (a New Tab's is dimmed). data-icon says which.
   */
  function tabIcon(linked) {
    if (linked) {
      const tree = window.PLIcons.icon('worktree', 14, 'tab-icon');
      tree.setAttribute('stroke-width', '2.1');
      tree.dataset.icon = 'worktree';
      return tree;
    }
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('class', 'tab-icon');
    svg.setAttribute('aria-hidden', 'true');
    svg.dataset.icon = 'branch';
    const shape = (name, attrs) => {
      const n = document.createElementNS(SVG, name);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      svg.append(n);
    };
    svg.setAttribute('viewBox', '0 0 16 16');
    const stroke = { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round' };
    shape('circle', { cx: '4.5', cy: '3.5', r: '1.75', ...stroke });
    shape('circle', { cx: '4.5', cy: '12.5', r: '1.75', ...stroke });
    shape('circle', { cx: '11.5', cy: '4.5', r: '1.75', ...stroke });
    shape('path', { d: 'M4.5 5.25v5.5M11.5 6.25c0 3-7 2-7 4.5', ...stroke });
    return svg;
  }

  /** Swap tab element el's icon (always its first child) when its kind changed (a tab can switch repos). */
  function setIcon(el, linked) {
    const cur = el.firstChild;
    if (cur.dataset.icon !== (linked ? 'worktree' : 'branch')) cur.replaceWith(tabIcon(linked));
  }

  function tabElement(id) {
    let el = els.get(id);
    if (el) return el;
    el = document.createElement('div');
    el.className = 'tab';
    el.setAttribute('role', 'tab');
    el.dataset.id = String(id);
    const title = document.createElement('span');
    title.className = 'tab-title';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'tab-close';
    close.tabIndex = -1; // the keyboard closes with Delete on the tab
    close.textContent = '×';
    close.addEventListener('pointerdown', (e) => e.stopPropagation()); // not a press on the tab
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(id);
    });
    el.append(tabIcon(false), title, close);
    els.set(id, el);
    return el;
  }

  function render() {
    const seen = new Set();
    const order = tabs.map((t) => {
      seen.add(t.id);
      const el = tabElement(t.id);
      setIcon(el, !!t.linked);
      el.querySelector('.tab-title').textContent = t.title;
      el.title = t.tooltip || t.title;
      el.setAttribute('aria-selected', t.active ? 'true' : 'false');
      el.classList.toggle('is-empty', !t.root);
      el.classList.toggle('is-busy', !!t.busy);
      el.setAttribute('aria-label', t.busy ? `${t.title} (working)` : t.title);
      el.querySelector('.tab-close').setAttribute('aria-label', `Close ${t.title}`);
      el.querySelector('.tab-close').title = t.active ? `Close Tab (${mod}W)` : 'Close Tab';
      return el;
    });
    for (const [id, el] of els) {
      if (!seen.has(id)) {
        el.remove();
        els.delete(id);
      }
    }
    // Reorder only what moved (replaceChildren would drop the focus and restart the hover).
    order.forEach((el, i) => { if (tablist.children[i] !== el) tablist.insertBefore(el, tablist.children[i] || null); });
    if (!tabs.some((t) => t.id === focusId)) focusId = null;
    const roving = focusId !== null ? focusId : (tabs.find((t) => t.active) || tabs[0] || {}).id;
    for (const t of tabs) els.get(t.id).tabIndex = t.id === roving ? 0 : -1;
    const active = tabs.find((t) => t.active);
    if (active) els.get(active.id).scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function apply(state) {
    if (!state || !Array.isArray(state.tabs)) return;
    tabs = state.tabs;
    document.documentElement.classList.toggle('is-fullscreen', !!state.fullscreen);
    if (!drag || !drag.active) render(); // a drag in progress redraws on drop
  }

  const fail = (what) => (err) => api.log('warn', `[tabs] ${what} failed`, { message: err && err.message, kind: err && err.kind });
  const activate = (id, o) => api.activate(id, o).catch(fail('activate'));
  const closeTab = (id) => api.close(id).catch(fail('close'));
  const tabIdOf = (el) => Number(el.dataset.id);
  const tabAt = (target) => (target && target.closest ? target.closest('.tab') : null);

  // ------------------------------------------------------------ mouse

  tablist.addEventListener('pointerdown', (e) => {
    const el = tabAt(e.target);
    if (!el) return;
    if (e.button === 1) {
      e.preventDefault(); // no autoscroll; auxclick closes
      return;
    }
    if (e.button !== 0) return;
    const id = tabIdOf(el);
    focusId = null;
    // Shown on press, as browsers do; the keyboard focus moves to its page on release (moving it
    // now could end the pointer capture a drag needs).
    activate(id, { keepFocus: true });
    drag = { id, el, startX: e.clientX, pointerId: e.pointerId, active: false, marker: null, index: null };
    try {
      el.setPointerCapture(e.pointerId);
    } catch { /* no such active pointer (a synthetic event): the drag still follows its moves */ }
  });

  /** Where a tab dropped at clientX would go: its index in the order without the dragged tab. */
  function dropIndex(clientX) {
    const others = [...tablist.children].filter((c) => c !== drag.el && c.classList.contains('tab'));
    let i = 0;
    for (const c of others) {
      const r = c.getBoundingClientRect();
      if (clientX > r.left + r.width / 2) i++;
    }
    return { i, others };
  }

  tablist.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (!drag.active && Math.abs(e.clientX - drag.startX) < DRAG_PX) return;
    if (!drag.active) {
      drag.active = true;
      drag.el.classList.add('is-dragging');
      drag.marker = document.createElement('div');
      drag.marker.className = 'drop-marker';
      document.body.append(drag.marker);
    }
    drag.el.style.transform = `translateX(${e.clientX - drag.startX}px)`;
    const { i, others } = dropIndex(e.clientX);
    drag.index = i;
    const ref = others[i] || others[others.length - 1];
    if (ref) {
      const r = ref.getBoundingClientRect();
      drag.marker.style.left = `${(others[i] ? r.left : r.right) - 1}px`;
    }
  });

  function endDrag(commit) {
    const d = drag;
    drag = null;
    if (!d) return;
    if (d.el.hasPointerCapture && d.el.hasPointerCapture(d.pointerId)) d.el.releasePointerCapture(d.pointerId);
    if (commit) activate(d.id); // its page gets the keyboard focus
    if (!d.active) return;
    d.el.classList.remove('is-dragging');
    d.el.style.transform = '';
    if (d.marker) d.marker.remove();
    const from = tabs.findIndex((t) => t.id === d.id);
    if (commit && d.index !== null && d.index !== from) {
      api.move(d.id, d.index).catch(fail('move')); // main answers with tabs-changed
    } else {
      render();
    }
  }
  tablist.addEventListener('pointerup', (e) => { if (drag && e.pointerId === drag.pointerId) endDrag(true); });
  tablist.addEventListener('pointercancel', () => endDrag(false));
  tablist.addEventListener('lostpointercapture', () => { if (drag) endDrag(drag.active); });

  tablist.addEventListener('auxclick', (e) => {
    const el = tabAt(e.target);
    if (el && e.button === 1) {
      e.preventDefault();
      closeTab(tabIdOf(el));
    }
  });

  tablist.addEventListener('contextmenu', (e) => {
    const el = tabAt(e.target);
    if (!el) return;
    e.preventDefault();
    api.menu(tabIdOf(el)).catch(fail('menu'));
  });

  newBtn.addEventListener('click', () => api.newTab().catch(fail('new tab')));

  // ------------------------------------------------------------ keyboard

  function moveFocus(toIndex) {
    if (!tabs.length) return;
    const t = tabs[(toIndex + tabs.length) % tabs.length];
    focusId = t.id;
    render();
    els.get(t.id).focus();
  }

  tablist.addEventListener('keydown', (e) => {
    const el = tabAt(e.target);
    if (!el || e.altKey || e.ctrlKey || e.metaKey) return;
    const id = tabIdOf(el);
    const i = tabs.findIndex((t) => t.id === id);
    const keys = {
      ArrowLeft: () => moveFocus(i - 1),
      ArrowRight: () => moveFocus(i + 1),
      Home: () => moveFocus(0),
      End: () => moveFocus(tabs.length - 1),
      Enter: () => activate(id, { keepFocus: true }),
      ' ': () => activate(id, { keepFocus: true }),
      Delete: () => closeTab(id),
      Backspace: () => closeTab(id),
      ContextMenu: () => api.menu(id).catch(fail('menu')),
    };
    let run = null;
    if (e.key === 'F10' && e.shiftKey) run = keys.ContextMenu;
    else if (!e.shiftKey || e.key === 'ContextMenu') run = keys[e.key];
    if (!run) return;
    e.preventDefault();
    run();
  });
  tablist.addEventListener('focusin', (e) => {
    const el = tabAt(e.target);
    if (el) focusId = tabIdOf(el);
  });

  // ------------------------------------------------------------ state

  api.subscribe(apply);
  api.list().then(apply, fail('list'));
})();
