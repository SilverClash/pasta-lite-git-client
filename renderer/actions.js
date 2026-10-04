'use strict';
// Shared action plumbing for the toolbar, sidebar, graph and keybindings (plain script; exposes
// window.Components.actions; loads after components.js, keys.js, policy.js and menus.js, before
// the flows and the components). It is the façade the components use: Components.actions is this
// file's own plumbing plus everything of
//   keys.js    (window.PLKeys)    the keybinding table and its glyphs: KEYS, matchKey, repeatBlocked,
//                                 keyHint, withKeyHint, keyGlyph, modClick
//   policy.js  (window.PLPolicy)  what is allowed when: BUSY_TITLE, FREE_FLOWS, START_FLOWS, WORKTREE_FLOWS,
//                                 isBare, bareTitle, bareBlocked, opBlocked, PULL_MODES, effectivePullMode,
//                                 hasRemotes, headView, availability, gateItems, shortcutFor, shortcutBlocked
//   menus.js   (window.PLMenus)   the menu descriptors: refMenuItems, commitOpItems, commitItems,
//                                 stashMenuItems, checkoutItem, checkoutRefusal, createHere, upstreamTarget, behindOf,
//                                 deleteItem, fullRef, deleteRefusal, deletableBranches, deleteBranchesItem,
//                                 worktreeRefusal, worktreeMenuItems
// Under node (the tests) this script requires fresh copies of the three, so they bind to the window
// the test just built.
//
// Descriptors: {label, flow, args, danger?, disabled?, title?, checked?} | {separator: true}.
// `flow` names a window.PLFlows function, called as PLFlows[flow](store, ...args). Labels and titles
// are display-safe (built with util.displayName) and reach the DOM through Components.menu (textContent).
//
//   flowsOf() -> window.PLFlows
//   runFlow(desc, store, flows?) -> Promise<boolean>   never throws; refuses while busy (except
//                                   FREE_FLOWS), when desc is disabled or its flow is missing; an
//                                   error not already toasted is logged (util.log) and toasted
//   toMenuItems(descs, store, flows?) -> Components.menu items
//   finishItems(descs, state, flows?) -> descs, disabled while busy or without their flow
//   bindContextMenu(el, {itemsFor(target, event), targetOf(event), anchorOf?(target, event), menu?})
//                                   -> disposer; right-click + ContextMenu key / Shift+F10
(function () {
  const C = window.Components;
  const { toError, log } = C.util;
  /** A part of the façade: window[name] in the page; a fresh copy of `file` under node. */
  const part = (name, file) => {
    if (typeof module === 'undefined' || typeof require !== 'function') return window[name];
    const p = require.resolve(file);
    delete require.cache[p];
    return require(p);
  };
  const Keys = part('PLKeys', './keys.js');
  const Policy = part('PLPolicy', './policy.js');
  const Menus = part('PLMenus', './menus.js');
  const { BUSY_TITLE, FREE_FLOWS } = Policy;
  const KEY_MENU_DEDUP_MS = 500; // a keyboard-opened menu also gets a 'contextmenu' event on some platforms

  const flowsOf = () => (typeof window !== 'undefined' ? window.PLFlows : undefined);
  const hasFlow = (flows, name) => !!flows && typeof flows[name] === 'function';

  // ---------------------------------------------------------------- running descriptors

  /** An error a flow threw (flows never throw on purpose): logged, then shown unless already toasted (util.report). */
  function report(store, e) {
    if (e && e.toasted) return;
    const err = toError(e);
    log.error(err);
    try {
      if (store && store.actions && typeof store.actions.toast === 'function') C.util.report(store, err);
    } catch {
      // nothing left to tell the user with
    }
  }

  /** Run descriptor d: Promise<boolean>; false (nothing run) while busy, disabled or without the flow. */
  async function runFlow(d, store, flows = flowsOf()) {
    if (!d || d.disabled || !store || !hasFlow(flows, d.flow)) return false;
    if (store.state && store.state.busy && !FREE_FLOWS.has(d.flow)) return false;
    try {
      return (await flows[d.flow](store, ...(d.args || []))) === true;
    } catch (e) {
      report(store, e);
      return false;
    }
  }

  /** Descriptors -> Components.menu items (actions run through runFlow). */
  const toMenuItems = (descs, store, flows = flowsOf()) => (descs || []).map((d) => {
    if (d.separator) return { separator: true };
    const item = { label: d.label, danger: !!d.danger, disabled: !!d.disabled, title: d.title, action: () => { runFlow(d, store, flows); } };
    if (d.checked !== undefined) item.checked = !!d.checked;
    return item;
  });

  /** Disable every actionable descriptor while busy (except FREE_FLOWS) or when its flow is missing. */
  function finishItems(descs, state, flows = flowsOf()) {
    const busy = !!(state && state.busy);
    return (descs || []).map((d) => {
      if (d.separator) return d;
      if (busy && !FREE_FLOWS.has(d.flow)) return { ...d, disabled: true, title: BUSY_TITLE };
      if (d.disabled) return d; // keeps its own explanation
      if (!hasFlow(flows, d.flow)) return { ...d, disabled: true, title: 'Not available' };
      return d;
    });
  }

  // ---------------------------------------------------------------- context menus

  const isMenuKey = (e) => e.key === 'ContextMenu' || (e.key === 'F10' && !!e.shiftKey);

  /**
   * Context menu on `el`: right-click (at the pointer), the ContextMenu key or Shift+F10 (anchored on
   * the target's element). targetOf(event) -> target | null (null: no menu); itemsFor(target, event)
   * -> Components.menu items (may have side effects such as selecting the row); anchorOf(target,
   * event) -> Element for keyboard / pointerless menus (default: the event's target, else el).
   * A keyboard-opened menu swallows the 'contextmenu' event that follows it on some platforms.
   * Returns a disposer.
   */
  function bindContextMenu(el, { itemsFor, targetOf, anchorOf, menu } = {}) {
    let keyMenuAt = 0;
    const menuApi = () => menu || window.Components.menu;
    const anchorFor = (target, e) => (typeof anchorOf === 'function' && anchorOf(target, e)) || (e.target && e.target.nodeType === 1 ? e.target : el);

    function open(e, pointer) {
      const m = menuApi();
      if (!m || typeof m.open !== 'function') return false;
      const target = targetOf(e);
      if (target === null || target === undefined) return false;
      const items = itemsFor(target, e);
      if (!items || !items.length) return false;
      m.open(pointer || anchorFor(target, e), items);
      return true;
    }

    function onContextMenu(e) {
      e.preventDefault();
      if (Date.now() - keyMenuAt < KEY_MENU_DEDUP_MS) return;
      // keyboard-generated events carry no pointer position: anchor on the target's element
      open(e, e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : null);
    }
    function onKeyDown(e) {
      if (!isMenuKey(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (open(e, null)) keyMenuAt = Date.now();
    }
    el.addEventListener('contextmenu', onContextMenu);
    el.addEventListener('keydown', onKeyDown);
    return () => {
      el.removeEventListener('contextmenu', onContextMenu);
      el.removeEventListener('keydown', onKeyDown);
    };
  }


  const api = {
    ...Keys, ...Policy, ...Menus,
    flowsOf, runFlow, toMenuItems, finishItems, bindContextMenu,
  };
  C.actions = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
