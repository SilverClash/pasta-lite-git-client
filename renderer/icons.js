'use strict';
// Inline SVG icons (plain script; exposes window.PLIcons, and module.exports under node for the tests;
// loads after components.js, before the components). Built with createElementNS: no innerHTML, no
// external assets. Used by the toolbar, the sidebar (its Worktrees section: worktree, home, lock),
// the repository picker and the WIP file lists; the tab strip (tabs.html, on its own: it needs
// nothing else) takes its linked-worktree tree icon from here.
//   PLIcons.icon(name, size = 18, className = '') -> <svg class="icon icon-<name> <className>">
(function () {
  const SVG_NS = 'http://www.w3.org/2000/svg';

  // 24×24 viewBox, stroked with currentColor (drawn at 18px by default). [tag, attrs] per shape.
  const P = (d) => ['path', { d }];
  const C = (cx, cy, r) => ['circle', { cx, cy, r }];
  const R = (x, y, width, height, rx) => ['rect', { x, y, width, height, rx }];
  const SHAPES = {
    undo: [P('M9 14 4 9l5-5'), P('M4 9h10.5a5.5 5.5 0 0 1 0 11H11')],
    redo: [P('m15 14 5-5-5-5'), P('M20 9H9.5a5.5 5.5 0 0 0 0 11H13')],
    pull: [P('M12 3v12'), P('m7 10 5 5 5-5'), P('M5 20h14')],
    push: [P('M12 21V9'), P('m7 14 5-5 5 5'), P('M5 4h14')],
    branch: [C(6, 5, 2), C(6, 19, 2), C(18, 6, 2), P('M6 7v10'), P('M18 8v1a5 5 0 0 1-5 5H9a3 3 0 0 0-3 3')],
    stash: [R(3, 4, 18, 5, 1), P('M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9'), P('M10 13h4')],
    pop: [P('M4 14v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5'), P('M12 16V4'), P('m8 8 4-4 4 4')],
    terminal: [R(3, 4, 18, 16, 2), P('m7 9 3 3-3 3'), P('M13 15h4')],
    folder: [P('M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v7a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5z')],
    'folder-open': [P('M3 17V7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h6.5A2.5 2.5 0 0 1 20 9.5V10'), P('M3 17l2.2-5.6A2 2 0 0 1 7.1 10H21l-2.6 7.2a2.5 2.5 0 0 1-2.3 1.8H5a2 2 0 0 1-2-2')],
    chevron: [P('m6 9 6 6 6-6')],
    'chevron-right': [P('m9 6 6 6-6 6')],
    check: [P('m5 12.5 4.5 4.5L19 7')],
    laptop: [R(4, 5, 16, 11, 1.5), P('M2 19h20')],
    cloud: [P('M7 18.5a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 9.5a4.5 4.5 0 0 1-.5 9z')],
    tag: [P('M3 12.2V4.5A1.5 1.5 0 0 1 4.5 3h7.7l8.8 8.8a1.5 1.5 0 0 1 0 2.1l-7.1 7.1a1.5 1.5 0 0 1-2.1 0z'), C(8, 8, 1.5)],
    search: [C(11, 11, 6.5), P('m16 16 4.5 4.5')],
    x: [P('M6 6l12 12'), P('M18 6 6 18')],
    'tab-new': [R(3, 5, 18, 14, 2), P('M3 9h7V5'), P('M15 11v6'), P('M12 14h6')],
    remote: [C(12, 12, 8.5), P('M3.5 12h17'), P('M12 3.5c2.5 2.3 3.5 5.2 3.5 8.5s-1 6.2-3.5 8.5c-2.5-2.3-3.5-5.2-3.5-8.5s1-6.2 3.5-8.5z')],
    detached: [C(12, 12, 3.5), P('M12 3v5.5'), P('M12 15.5V21')],
    trash: [P('M4 7h16'), P('M10 11v6'), P('M14 11v6'), P('M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12'), P('M9 7V4h6v3')],
    worktree: [C(12, 8.5, 5.5), P('M12 14v7'), P('M8.5 21h7'), P('M12 17l-3-2.5')],
    home: [P('M4 11 12 4l8 7'), P('M6 9.5V20h12V9.5'), P('M10 20v-5h4v5')],
    lock: [R(5, 11, 14, 9, 1.5), P('M8 11V8a4 4 0 0 1 8 0v3')],
  };

  /** <svg> icon built with createElementNS (no innerHTML, no external assets). */
  function icon(name, size = 18, className = '') {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.7');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', `icon icon-${name}${className ? ` ${className}` : ''}`);
    for (const [tag, attrs] of SHAPES[name] || []) {
      const s = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, String(v));
      svg.append(s);
    }
    return svg;
  }

  const api = { icon };
  if (typeof window !== 'undefined') window.PLIcons = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
