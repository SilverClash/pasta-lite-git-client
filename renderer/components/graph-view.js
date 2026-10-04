'use strict';
// graph-view component — the virtualized commit graph.
//
// Layout: a single scroll container holding a sticky column header and a body whose height is
// rows * ROW_H. Only the visible rows (+ OVERSCAN) exist in the DOM; row elements are pooled and
// re-bound to a new row index when they scroll out of view (positioned with transform).
// Columns: BRANCH / TAG | GRAPH (per-row SVG) | COMMIT MESSAGE | AUTHOR | DATE | SHA. Their widths are
// window.PLColumns (graph-columns.js), applied as CSS variables on the root (one style change for
// every row); the header's separators resize them (drag, arrows, double-click / Enter to fit), and
// the header's context menu resets them.
// All git-derived text goes through textContent (and util.displayName, so bidi/control characters
// can't disguise a name); SVG is built with createElementNS.
// Accessibility: the scroller is a single-select grid (rows with gridcells, aria-selected); it keeps
// focus itself and points aria-activedescendant at the selected row while that row is rendered.
// The centre pane: the graph shows itself while state.centre is 'graph' (a diff or the interactive rebase
// editor replaces it) and takes the focus back when it returns with nothing focused.
// Lane colours: colorIndex comes from Graph.layout (0 .. Graph.COLOR_COUNT - 1), one lane-* class
// set per index in graph-view.css.
// Context menu on a commit row (right-click, Shift+F10 / ContextMenu key on the selected row), on a
// ref pill (right-click: the ref's own menu, Components.actions.refMenuItems) and double-click on a
// local branch pill run window.PLFlows actions; a branch checked out in another worktree is not
// checked out (its menu item is disabled with the reason, Components.actions.checkoutRefusal).
// The pure pieces (refPills, rowView, commitMenuItems, pillAction) are top-level and exported for tests when loaded by node.
(function () {
  const { el, util } = window.Components;
  const { relTime, absTime, initials, displayName, inTextField, modalOpen, plural, short } = util;
  const SVG = 'http://www.w3.org/2000/svg';

  const ROW_H = 28;
  const MID = ROW_H / 2;
  const LANE_W = 22;
  const LANE_X0 = 16; // centre of column 0
  const OVERSCAN = 10;
  // Ask for the next page this far above the bottom: 40 rows, more than a screen, so the page
  // usually lands before the user reaches the end; well under one page (PAGE_MORE, 200 rows in
  // store.js), so a page that just arrived moves the bottom out of range again.
  const PAGE_AHEAD_ROWS = 40;
  const PAGE_AHEAD_PX = PAGE_AHEAD_ROWS * ROW_H;
  const NODE_R = 10;
  const MERGE_R = 5;
  const CORNER = 12; // radius of the rounded corner where a lane turns toward another column
  const BODY_MAX = 240; // chars of the body rendered next to the subject
  const REFS_RESERVE = 44; // BRANCH / TAG width beyond its pill: .gv-pill max-width is var(--gv-refs-w) - 44px
  const FIT_SAMPLE = 400; // auto-fit measures at most this many distinct values per column (the longest)
  const KEY_STEP = 10; // px per arrow key on a column separator (Shift: KEY_STEP_BIG)
  const KEY_STEP_BIG = 50;

  const laneX = (col) => LANE_X0 + col * LANE_W;
  // The text of a commit in the AUTHOR / DATE / SHA column (for auto-fit).
  const shortHash = (cm) => short(cm.hash);
  const COLUMN_TEXT = { author: (cm) => displayName(cm.author), date: (cm) => relTime(cm.date), sha: shortHash };

  /**
   * Whether the graph's navigation keys (j/k, arrows, Home/End, PgUp/PgDn) apply with `active`
   * focused: the graph itself (inside `scroller`), nothing (body / no element), or a button of the
   * toolbar ([role="toolbar"], e.g. Undo just clicked). Any other focus keeps its keys: a WIP-panel
   * button (Stage All Changes), a file or sidebar row, a list, tree, menu or dialog. Pure (DOM reads only).
   */
  function ownsNavKeys(active, scroller) {
    if (!active || active === document.body || active === document.documentElement) return true;
    if (scroller && scroller.contains(active)) return true;
    return active.tagName === 'BUTTON' && typeof active.closest === 'function' && !!active.closest('[role="toolbar"]');
  }

  function svg(tag, attrs) {
    const e = document.createElementNS(SVG, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  // ------------------------------------------------------------------ formatting

  function bodyLine(body) {
    if (!body) return '';
    const s = body.replace(/\s+/g, ' ').trim();
    return displayName(s.length > BODY_MAX ? s.slice(0, BODY_MAX) + '…' : s);
  }


  // ------------------------------------------------------------------ ref labels

  /**
   * Turn refsBySha entries into display pills. A local branch and its configured upstream pointing at
   * the same commit become one pill with both markers; a branch without an upstream pairs with a
   * remote branch of exactly the same branch name (remoteBranch: remote ref name -> branch part).
   * Order: HEAD, current branch, locals, remotes, tags. Names in the result are display-safe; `ref`
   * keeps the raw ref name (local, remote, tag) for the actions, `remoteName` a remote pill's remote.
   */
  function refPills(refs, remoteBranch) {
    if (!refs || !refs.length) return [];
    const remotes = new Map();
    for (const r of refs) if (r.type === 'remote') remotes.set(r.name, r);
    const used = new Set();
    const pairOf = (r) => {
      if (r.upstream) return remotes.get(r.upstream) || null; // tracking elsewhere: never guess
      for (const [n, rr] of remotes) if (!used.has(n) && remoteBranch.get(n) === r.name) return rr;
      return null;
    };
    const pills = [];
    for (const r of refs) {
      if (r.type === 'head') pills.push({ kind: 'head', name: 'HEAD', title: 'HEAD (detached)', rank: 0 });
    }
    for (const r of refs) {
      if (r.type !== 'local') continue;
      const up = pairOf(r);
      if (up) used.add(up.name);
      const name = displayName(r.name);
      pills.push({
        kind: 'local', name, ref: r.name, current: !!r.current, remote: up ? up.name : null,
        title: `${r.current ? 'Current branch ' : 'Local branch '}${name}${up ? ` (in sync with ${displayName(up.name)})` : ''}`,
        rank: r.current ? 1 : 2,
      });
    }
    for (const r of refs) {
      if (r.type === 'remote' && !used.has(r.name)) {
        const name = displayName(r.name);
        pills.push({ kind: 'remote', name, ref: r.name, remoteName: r.remote || null, title: `Remote branch ${name}`, rank: 3 });
      }
    }
    for (const r of refs) {
      if (r.type === 'tag') {
        const name = displayName(r.name);
        pills.push({ kind: 'tag', name, ref: r.name, title: `Tag ${name}`, rank: 4 });
      }
    }
    pills.sort((a, b) => a.rank - b.rank); // stable: keeps git's order within a rank
    return pills;
  }

  /**
   * Display data for graph row `row` with layout row `g` (pure; everything display-safe).
   * ctx: {refsBySha, remoteBranch, status}. The WIP row clears every text and tooltip, so a recycled
   * row element never keeps a commit's author/SHA tooltip. Its subject is '// WIP', or '// Rebasing 3/7'
   * / '// Merging' while an operation is in progress (PLOp.wipLabel).
   */
  function rowView(row, g, { refsBySha, remoteBranch, status }) {
    const lane = g ? g.colorIndex : 0;
    if (row.kind === 'wip') {
      return {
        wip: true, merge: false, lane, pills: [], subject: window.PLOp ? window.PLOp.wipLabel(status) : '// WIP', count: plural(W.wipCount(status), 'file'),
        body: '', author: '', authorTitle: '', date: '', dateTitle: '', sha: '', shaTitle: '',
      };
    }
    const c = row.commit;
    const author = displayName(c.author);
    return {
      wip: false, merge: !!(g && g.isMerge), lane,
      pills: refPills(refsBySha.get(c.hash), remoteBranch),
      subject: displayName(c.subject), count: null, body: bodyLine(c.body),
      author, authorTitle: c.email ? `${author} <${displayName(c.email)}>` : author,
      date: relTime(c.date), dateTitle: absTime(c.date),
      sha: short(c.hash), shaTitle: c.hash,
    };
  }

  // ------------------------------------------------------------------ actions (pure)
  //
  // Components.actions descriptors (as in the sidebar): {label, flow, args, danger?, disabled?, title?} |
  // {separator: true}; `flow` names a window.PLFlows function, called as flows[flow](store, ...args).

  // Components.actions (renderer/actions.js) loads before the components; node tests that load this
  // script alone get a fresh copy bound to their window (util.load).
  const A = util.load('Components.actions', './actions.js');
  const { flowsOf, runFlow, toMenuItems, bindContextMenu, bareBlocked } = A;
  // window.PLColumns (graph-columns.js) and window.PLWip (wip-model.js, the WIP row's file count) load
  // before this script; node tests get fresh copies (util.load).
  const Cols = util.load('PLColumns', './components/graph-columns.js');
  const W = util.load('PLWip', './components/wip-model.js');

  /**
   * Context menu descriptors for graph row `row` (none for the WIP row): Components.actions.commitItems
   * (check out the commit, create a branch there, rebase / merge onto it, check out its local branches).
   */
  function commitMenuItems(row, state, flows = flowsOf()) {
    if (!row || row.kind !== 'commit' || !row.commit) return [];
    return A.commitItems(row.commit.hash, state, flows);
  }

  /**
   * The ref behind pill p (refPills item) of the commit `hash`, as Components.actions.refMenuItems
   * takes it ({kind, name, oid, current, remote?}), or null (HEAD pill, no raw name).
   */
  function pillTarget(p, hash) {
    if (!p || !p.ref || !['local', 'remote', 'tag'].includes(p.kind)) return null;
    const t = { kind: p.kind, name: p.ref, oid: hash, current: p.kind === 'local' && !!p.current };
    if (p.kind === 'remote') t.remote = p.remoteName || null;
    return t;
  }

  /** Context menu descriptors of ref pill p on graph row `row` (the sidebar's menu for that ref). */
  function pillMenuItems(p, row, state, flows = flowsOf()) {
    const t = row && row.kind === 'commit' && row.commit ? pillTarget(p, row.commit.hash) : null;
    return t ? A.refMenuItems(t, state, flows) : [];
  }

  /**
   * Double-click on pill p (refPills item): check out a local branch that isn't current, else null
   * (also while busy, for a branch checked out in another worktree (checkoutRefusal) and in a bare
   * repository, which has nothing to check out into: bareBlocked).
   * While a rebase / merge / … is in progress the flow itself refuses with the reason (PLPolicy.opBlocked).
   */
  function pillAction(p, state) {
    if (!p || p.kind !== 'local' || p.current || !p.ref || (state && state.busy)) return null;
    if (A.checkoutRefusal(p.ref, state)) return null; // checked out in another worktree
    const d = { flow: 'checkout', args: [{ target: p.ref, kind: 'local' }] };
    return bareBlocked(state, d.flow, d.args) ? null : d;
  }

  function pillEl(p, lane) {
    const e = el('span', `gv-pill gv-pill-${p.kind} lane-bg-${lane}${p.current ? ' is-current' : ''}`);
    if (p.current) e.append(el('span', 'gv-check', '✓'));
    if (p.kind === 'local' || p.kind === 'head') e.append(el('span', 'gv-ico gv-ico-local'));
    if (p.kind === 'local' && p.remote) e.append(el('span', 'gv-ico gv-ico-remote'));
    if (p.kind === 'remote') e.append(el('span', 'gv-ico gv-ico-remote'));
    if (p.kind === 'tag') e.append(el('span', 'gv-ico gv-ico-tag'));
    e.append(el('span', 'gv-pill-name', p.name));
    return e;
  }

  // ------------------------------------------------------------------ graph cell

  /** SVG path for one layout line (straight when vertical, rounded corner when changing column). */
  function linePath(ln) {
    const [c1, a1] = ln.from;
    const [c2, a2] = ln.to;
    const x1 = laneX(c1);
    const x2 = laneX(c2);
    const y1 = a1 === 'top' ? 0 : MID;
    const y2 = a2 === 'bottom' ? ROW_H : MID;
    if (c1 === c2) return `M${x1} ${y1}V${y2}`;
    const dir = x2 > x1 ? 1 : -1;
    const r = Math.min(CORNER, Math.abs(x2 - x1));
    if (a1 === 'top') {
      // coming down lane c1, turning horizontally into the node at c2
      return `M${x1} ${y1}V${MID - r}Q${x1} ${MID} ${x1 + dir * r} ${MID}H${x2}`;
    }
    // leaving the node horizontally, turning down into lane c2
    return `M${x1} ${MID}H${x2 - dir * r}Q${x2} ${MID} ${x2} ${MID + r}V${y2}`;
  }

  function drawGraph(svgEl, g, row, hasRefs) {
    svgEl.replaceChildren();
    if (!g) return;
    const maxCol = g.lines.reduce((m, ln) => Math.max(m, ln.from[0], ln.to[0]), g.column);
    const w = laneX(maxCol) + LANE_W;
    svgEl.setAttribute('width', w);
    svgEl.setAttribute('viewBox', `0 0 ${w} ${ROW_H}`);
    const wip = row.kind === 'wip';
    const cx = laneX(g.column);
    const lane = g.colorIndex;
    if (hasRefs && cx > NODE_R) {
      // faint connector from the ref label to the node
      svgEl.append(svg('path', { d: `M0 ${MID}H${cx}`, class: `gv-ref-link lane-stroke-${lane}` }));
    }
    // Straight lanes first, then the curves (merges / forks) on top of them.
    const cls = (ln) => `gv-line lane-stroke-${ln.colorIndex}${wip ? ' is-wip' : ''}`;
    for (const ln of g.lines) if (ln.from[0] === ln.to[0]) svgEl.append(svg('path', { d: linePath(ln), class: cls(ln) }));
    for (const ln of g.lines) if (ln.from[0] !== ln.to[0]) svgEl.append(svg('path', { d: linePath(ln), class: cls(ln) }));
    if (wip) {
      svgEl.append(svg('circle', { cx, cy: MID, r: NODE_R - 1.5, class: `gv-node-wip lane-stroke-${lane}` }));
    } else if (g.isMerge) {
      svgEl.append(svg('circle', { cx, cy: MID, r: MERGE_R, class: `gv-node-merge lane-fill-${lane}` }));
    } else {
      svgEl.append(svg('circle', { cx, cy: MID, r: NODE_R, class: `gv-node lane-fill-${lane}` }));
      const t = svg('text', { x: cx, y: MID, class: `gv-initials lane-text-${lane}` });
      t.textContent = initials(displayName(row.commit.author));
      svgEl.append(t);
    }
  }

  // ------------------------------------------------------------------ component

  window.Components.register('graph-view', {
    mount(root, store) {
      const S = store.state;

      const scroller = el('div', 'gv-scroll');
      scroller.tabIndex = 0;
      scroller.setAttribute('role', 'grid');
      scroller.setAttribute('aria-label', 'Commits');
      scroller.setAttribute('aria-multiselectable', 'false');
      const idPrefix = `gv${Math.random().toString(36).slice(2, 8)}`;
      const rowId = (i) => `${idPrefix}-r${i}`;
      const header = el('div', 'gv-header');
      header.setAttribute('role', 'row');
      header.setAttribute('aria-rowindex', '1');
      const handles = new Map(); // column id -> its separator (the drag handle)
      for (const id of ['refs', 'graph', 'msg', 'author', 'date', 'sha']) {
        const c = Cols.column(id);
        const h = el('div', `gv-cell gv-c-${id}`);
        h.setAttribute('role', 'columnheader');
        h.append(el('span', 'gv-h-label', c ? c.label : 'Commit message'));
        if (c) {
          const r = el('div', `gv-resize gv-resize-${c.edge}`);
          r.tabIndex = 0;
          r.dataset.col = id;
          r.setAttribute('role', 'separator');
          r.setAttribute('aria-orientation', 'vertical');
          r.setAttribute('aria-label', `Resize ${c.label} column`);
          r.title = id === 'graph' ? 'Drag to resize, double-click to fit the lanes' : 'Drag to resize, double-click to fit';
          h.append(r);
          handles.set(id, r);
        }
        header.append(h);
      }
      const body = el('div', 'gv-body');
      const empty = el('div', 'gv-empty');
      empty.hidden = true;
      scroller.append(header, body);
      root.append(scroller, empty);

      // ---------------------------------------------------------- row pool
      /** index -> row element currently bound to it (updated in place by render) */
      const bound = new Map();
      const pool = [];
      let bodyTop = 0; // offset of the body inside the scroller (header height)
      let disposed = false;

      function makeRow() {
        const r = el('div', 'gv-row');
        r.setAttribute('role', 'row');
        const cell = (cls) => {
          const c = el('div', `gv-cell ${cls}`);
          c.setAttribute('role', 'gridcell');
          return c;
        };
        const refs = cell('gv-c-refs');
        const graph = cell('gv-c-graph');
        const svgEl = svg('svg', { class: 'gv-svg', height: ROW_H, 'aria-hidden': 'true' });
        graph.append(svgEl);
        const msg = cell('gv-c-msg');
        const subject = el('span', 'gv-subject');
        const count = el('span', 'gv-wip-count');
        const bodyTxt = el('span', 'gv-bodytext');
        msg.append(subject, count, bodyTxt);
        const author = cell('gv-c-author');
        const date = cell('gv-c-date');
        const sha = cell('gv-c-sha');
        r.append(refs, graph, msg, author, date, sha);
        r._p = { refs, svgEl, subject, count, bodyTxt, author, date, sha, pill: null, key: null, idx: -1 };
        return r;
      }

      const selIndex = () => store.rowIndexOf(S.selection);
      let selIdx = -1;

      let renderGen = 0; // bumped when row content (not just position) must be rebuilt
      function bind(r, i) {
        const p = r._p;
        const row = S.rows[i];
        const g = S.graph.rows[i];
        const key = row.kind === 'wip' ? `wip:${renderGen}` : `${row.commit.hash}:${renderGen}`;
        if (p.idx !== i) {
          r.style.transform = `translateY(${i * ROW_H}px)`;
          r.dataset.index = i;
          r.id = rowId(i);
          r.setAttribute('aria-rowindex', String(i + 2)); // header is row 1
          p.idx = i;
        }
        const selected = i === selIdx;
        r.classList.toggle('is-selected', selected);
        r.setAttribute('aria-selected', selected ? 'true' : 'false');
        if (p.key === key) return;
        p.key = key;
        const v = rowView(row, g, { refsBySha: S.refsBySha, remoteBranch: remoteBranchOf(), status: S.status });
        r.classList.toggle('is-wip', v.wip);
        r.classList.toggle('is-merge', v.merge);

        p.refs.replaceChildren();
        p.refs.title = '';
        p.pill = v.pills[0] || null;
        if (v.pills.length) {
          p.refs.append(pillEl(v.pills[0], v.lane));
          if (v.pills.length > 1) p.refs.append(el('span', `gv-more lane-bg-${v.lane}`, `+${v.pills.length - 1}`));
          p.refs.title = v.pills.map((x) => x.title).join('\n')
            + (v.pills[0].kind === 'local' && !v.pills[0].current ? '\nDouble-click the branch to check it out' : '');
          p.refs.append(el('span', `gv-ref-line lane-line-${v.lane}`));
        }

        drawGraph(p.svgEl, g, row, v.pills.length > 0);

        p.subject.textContent = v.subject;
        p.count.textContent = v.count || '';
        p.count.hidden = v.count === null;
        p.bodyTxt.textContent = v.body;
        p.author.textContent = v.author;
        p.author.title = v.authorTitle;
        p.date.textContent = v.date;
        p.date.title = v.dateTitle;
        p.sha.textContent = v.sha;
        p.sha.title = v.shaTitle;
      }

      // remote ref name -> its branch part ("origin/release/main" -> "release/main"), per refs value
      const remoteBranches = { refs: undefined, map: new Map() };
      function remoteBranchOf() {
        if (remoteBranches.refs !== S.refs) {
          remoteBranches.refs = S.refs;
          remoteBranches.map = new Map(((S.refs && S.refs.remote) || []).map((b) => [b.name, b.branch]));
        }
        return remoteBranches.map;
      }

      function render() {
        const n = S.rows.length;
        body.style.height = `${n * ROW_H}px`;
        const top = scroller.scrollTop - bodyTop;
        const h = scroller.clientHeight;
        const first = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
        const last = Math.min(n - 1, Math.ceil((top + h) / ROW_H) + OVERSCAN);
        // release rows that left the window
        for (const [i, r] of bound) {
          if (i < first || i > last || i >= n) {
            pool.push(r);
            bound.delete(i);
          }
        }
        for (let i = first; i <= last; i++) {
          const r = bound.get(i) || pool.pop() || body.appendChild(makeRow());
          r.hidden = false;
          bound.set(i, r);
          bind(r, i);
        }
        for (const r of pool) {
          if (!r.hidden) {
            r.hidden = true;
            r._p.idx = -1;
            r.removeAttribute('id');
          }
        }
        if (selIdx >= 0 && bound.has(selIdx)) scroller.setAttribute('aria-activedescendant', rowId(selIdx));
        else scroller.removeAttribute('aria-activedescendant');
        maybeLoadMore();
      }

      function maybeLoadMore() {
        if (!S.hasMore || !S.rows.length) return;
        const remaining = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
        if (remaining < PAGE_AHEAD_PX) store.actions.loadMore();
      }

      // ---------------------------------------------------------- column widths
      const prefs = Cols.prefs;
      let lanesW = 0; // width the lanes need (px)
      let avail = 0; // the scroller's client width, read on resize (ResizeObserver)
      let lay = null; // PLColumns.layout of what is shown
      let drag = null; // {id, handle, pointerId, x, w0, dir, widths} while a separator is dragged
      const shownVars = {}; // column id -> the CSS value last set
      const current = () => (drag ? drag.widths : prefs.get());

      /** Fit the widths to the scroller and set the CSS variables, hidden columns, clipped lanes and separator values. */
      function applyColumns() {
        lay = Cols.layout(current(), { avail, graphAuto: Cols.graphAuto(lanesW) });
        for (const c of Cols.COLUMNS) {
          const v = `${lay.w[c.id]}px`;
          if (shownVars[c.id] !== v) {
            shownVars[c.id] = v;
            root.style.setProperty(`--gv-${c.id}-w`, v);
          }
          root.classList.toggle(`gv-hide-${c.id}`, lay.hidden[c.id]);
          const r = handles.get(c.id);
          r.setAttribute('aria-valuenow', String(lay.w[c.id]));
          r.setAttribute('aria-valuemin', String(c.min));
          r.setAttribute('aria-valuemax', String(Cols.maxFor(c.id, lay)));
        }
        root.classList.toggle('gv-graph-clipped', lanesW > lay.w.graph);
      }
      const unsubPrefs = prefs.subscribe(() => applyColumns());

      function updateGraphWidth() {
        lanesW = laneX(Math.max(0, S.graph.width - 1)) + LANE_W;
        applyColumns();
      }

      /** Set column `id` to `target` px (clamped: PLColumns.resizeTo) and save it. */
      function resizeColumn(id, target) {
        prefs.set(Cols.resizeTo(prefs.get(), id, target, lay));
      }

      /**
       * Natural widths (px, padding included) of column `id`'s content in the loaded rows and its
       * header label, measured in one hidden probe (one layout pass). BRANCH / TAG measures each
       * row's first pill (the one shown) plus REFS_RESERVE. At most FIT_SAMPLE distinct values (the
       * longest strings). [] where nothing can be measured.
       */
      function measureColumn(id) {
        const c = Cols.column(id);
        if (!c || id === 'graph') return [];
        const probe = el('div', 'gv-measure');
        probe.setAttribute('aria-hidden', 'true');
        const items = [{ node: el('div', `gv-cell gv-c-${id} gv-measure-head`, c.label), add: 0 }];
        const commits = S.rows.filter((r) => r.kind === 'commit' && r.commit).map((r) => r.commit);
        const longest = (values) => [...new Set(values)].sort((a, b) => b.length - a.length).slice(0, FIT_SAMPLE);
        if (id === 'refs') {
          const pills = new Map();
          for (const cm of commits) {
            const p = refPills(S.refsBySha.get(cm.hash), remoteBranchOf())[0];
            if (p) pills.set(`${p.kind}|${!!p.current}|${!!p.remote}|${p.name}`, p);
          }
          const keep = new Set(longest([...pills.values()].map((p) => p.name)));
          for (const p of pills.values()) if (keep.has(p.name)) items.push({ node: pillEl(p, 0), add: REFS_RESERVE });
        } else {
          const text = COLUMN_TEXT[id] || shortHash;
          for (const t of longest(commits.map(text))) items.push({ node: el('div', `gv-cell gv-c-${id}`, t), add: 0 });
        }
        probe.append(...items.map((it) => it.node));
        root.append(probe);
        try {
          return items.filter((it) => it.node.offsetWidth > 0).map((it) => it.node.offsetWidth + it.add);
        } finally {
          probe.remove();
        }
      }

      /** Auto-fit column `id` to its content (GRAPH, or nothing measurable: back to the default). */
      function fitColumn(id) {
        const w = Cols.fitWidth(id, measureColumn(id));
        if (w === null) prefs.set({ ...prefs.get(), [id]: null });
        else resizeColumn(id, w);
      }

      function updateEmpty() {
        const n = S.rows.length;
        if (!S.repo || n) {
          empty.hidden = true;
          return;
        }
        empty.replaceChildren();
        if (S.loading) {
          empty.append(el('div', 'gv-spinner'), el('div', 'gv-empty-title', 'Loading history…'));
        } else if (S.loadError) {
          empty.append(el('div', 'gv-empty-art gv-empty-error'), el('div', 'gv-empty-title', 'Couldn’t load this repository'),
            el('div', 'gv-empty-sub', displayName(S.loadError)));
        } else {
          empty.append(el('div', 'gv-empty-art'), el('div', 'gv-empty-title', 'No commits yet'),
            el('div', 'gv-empty-sub', 'Make your first commit and it will show up here.'));
        }
        empty.hidden = false;
      }

      /** Keep the selected row inside the viewport (below the sticky header). */
      function revealSelection() {
        if (selIdx < 0) return;
        const y = bodyTop + selIdx * ROW_H;
        const viewTop = scroller.scrollTop + bodyTop;
        const viewBottom = scroller.scrollTop + scroller.clientHeight;
        if (y < viewTop) scroller.scrollTop = y - bodyTop;
        else if (y + ROW_H > viewBottom) scroller.scrollTop = y + ROW_H - scroller.clientHeight;
      }

      const rowFullyVisible = (i) => {
        const y = bodyTop + i * ROW_H - scroller.scrollTop;
        return y >= bodyTop && y + ROW_H <= scroller.clientHeight;
      };
      /** Centre row i in the viewport (below the header) unless it is already fully visible. */
      function centreRow(i) {
        if (i < 0 || rowFullyVisible(i)) return;
        body.style.height = `${S.rows.length * ROW_H}px`;
        scroller.scrollTop = Math.max(0, i * ROW_H + ROW_H / 2 - (scroller.clientHeight - bodyTop) / 2);
      }

      // Selections made by the graph itself (click, keys) scroll minimally; selections made elsewhere
      // (sidebar: branch / tag / remote click) centre the row, paging history in if necessary.
      let internalSel = 0;
      const selectLocal = (fn) => {
        internalSel++;
        try { fn(); } finally { internalSel--; }
      };
      let hunt = null; // selection object currently being searched for
      async function huntSelection(sel) {
        if (hunt === sel) return;
        if (S.stashes.some((st) => st.hash === sel.sha)) return; // stash commits are never graph rows
        hunt = sel;
        const repo = S.repo;
        const stillWanted = () => !disposed && S.selection === sel && S.repo === repo;
        try {
          while (stillWanted() && selIndex() < 0 && S.hasMore && S.commits.length < window.Store.LOG_MAX) {
            const next = S.next;
            // Shares any in-flight page load and resolves once it has landed; a failure is toasted
            // by the action (once) and leaves the history unchanged, which ends the hunt.
            await store.actions.loadMore();
            if (S.next === next) return; // no progress: the load failed
          }
          if (!stillWanted()) return;
          selIdx = selIndex();
          if (selIdx >= 0) {
            render();
            centreRow(selIdx);
          }
        } finally {
          if (hunt === sel) hunt = null;
        }
      }
      function revealExternal() {
        const sel = S.selection;
        if (!sel) return;
        if (selIdx >= 0) centreRow(selIdx);
        else if (sel.kind === 'commit' && sel.sha) huntSelection(sel);
      }

      // ---------------------------------------------------------- store wiring
      let prevRows = S.rows;
      let prevRepo = S.repo && S.repo.root;
      const rowKey = (r) => {
        if (!r) return null;
        return r.kind === 'wip' ? 'wip' : r.commit.hash;
      };

      /** Index of the row with key k within 64 rows of `around`, or -1. */
      function findRowNear(k, around) {
        for (let d = 0; d < 64; d++) {
          if (rowKey(S.rows[around + d]) === k) return around + d;
          if (around - d >= 0 && rowKey(S.rows[around - d]) === k) return around - d;
        }
        return -1;
      }

      function onChange(state, changed) {
        const has = (k) => changed.includes(k);
        const repoRoot = S.repo && S.repo.root;
        if (has('repo') && repoRoot !== prevRepo) {
          prevRepo = repoRoot;
          scroller.scrollTop = 0;
        }
        if (has('rows') || has('graph')) {
          // Scroll anchoring: keep the top visible row in place when rows shift (WIP row appears /
          // disappears, new commits on top) — unless we're at the very top, where new rows should show.
          const oldRows = prevRows;
          prevRows = S.rows;
          const top = scroller.scrollTop - bodyTop;
          if (top >= ROW_H && oldRows.length && S.rows.length) {
            const oi = Math.min(oldRows.length - 1, Math.floor(top / ROW_H));
            const k = rowKey(oldRows[oi]);
            if (rowKey(S.rows[oi]) !== k) {
              const ni = findRowNear(k, oi);
              if (ni >= 0) {
                body.style.height = `${S.rows.length * ROW_H}px`;
                scroller.scrollTop += (ni - oi) * ROW_H;
              }
            }
          }
          updateGraphWidth();
        }
        if (has('rows') || has('graph') || has('refsBySha') || has('status')) renderGen++;
        if (has('rows') || has('selection')) selIdx = selIndex();
        if (has('rows') || has('loading') || has('repo') || has('loadError')) updateEmpty();
        render();
        if (has('selection')) {
          if (internalSel) revealSelection();
          else revealExternal();
        }
      }
      const unsub = store.subscribe(['rows', 'graph', 'refsBySha', 'selection', 'status', 'loading', 'repo', 'hasMore', 'loadError'], onChange);

      // The centre pane (state.centre): hidden while a diff or the rebase editor is shown. Back from one,
      // the graph takes the focus once the other view has handed it on (a microtask: after every listener
      // of this change), unless something else has it.
      let shownCentre = S.centre;
      function onCentre() {
        const was = shownCentre;
        shownCentre = S.centre;
        root.hidden = S.centre !== 'graph';
        if (S.centre !== 'graph' || was === 'graph' || was === undefined) return;
        queueMicrotask(() => {
          const a = document.activeElement;
          if (!disposed && S.centre === 'graph' && (!a || a === document.body)) scroller.focus({ preventScroll: true });
        });
      }
      const unsubCentre = store.subscribe(['centre'], onCentre);
      if (S.centre !== undefined) root.hidden = S.centre !== 'graph';

      // ---------------------------------------------------------- events
      scroller.addEventListener('scroll', render, { passive: true });
      const ro = new ResizeObserver(() => {
        bodyTop = body.offsetTop;
        avail = scroller.clientWidth || 0;
        applyColumns();
        render();
      });
      ro.observe(scroller);

      // Column separators. Dragging one (pointer capture) resizes a draft of the widths, applied
      // live and saved on release. The handle moves with the pointer: dir is +1 for a right-border
      // separator (BRANCH / TAG, GRAPH), -1 for a left-border one (AUTHOR, DATE, SHA). Keys follow
      // the separator too: Left / Right move it by KEY_STEP (Shift: KEY_STEP_BIG), Home / End give
      // the column its min / max, Enter fits it (as a double-click does).
      const handleOf = (e) => (e.target && e.target.closest ? e.target.closest('.gv-resize') : null);
      const dirOf = (id) => (Cols.column(id).edge === 'right' ? 1 : -1);
      function onPointerDown(e) {
        const r = handleOf(e);
        if (!r || e.button !== 0 || !lay) return;
        e.preventDefault(); // no text selection, no native drag
        const id = r.dataset.col;
        drag = { id, handle: r, pointerId: e.pointerId, x: e.clientX, w0: lay.w[id], dir: dirOf(id), widths: prefs.get() };
        if (typeof r.setPointerCapture === 'function' && e.pointerId !== undefined) {
          try { r.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
        }
        r.classList.add('is-active');
        root.classList.add('gv-resizing');
      }
      function onPointerMove(e) {
        if (!drag || e.pointerId !== drag.pointerId) return;
        drag.widths = Cols.resizeTo(drag.widths, drag.id, drag.w0 + drag.dir * (e.clientX - drag.x), lay);
        applyColumns();
      }
      function endDrag(e) {
        if (!drag || (e && e.pointerId !== drag.pointerId)) return;
        const d = drag;
        drag = null;
        d.handle.classList.remove('is-active');
        root.classList.remove('gv-resizing');
        if (typeof d.handle.releasePointerCapture === 'function' && d.pointerId !== undefined) {
          try { d.handle.releasePointerCapture(d.pointerId); } catch { /* already released */ }
        }
        if (!prefs.set(d.widths)) applyColumns(); // unchanged: show the saved widths again
      }
      function onHeaderKey(e) {
        const r = handleOf(e);
        if (!r || !lay || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
        const id = r.dataset.col;
        const c = Cols.column(id);
        const step = (e.shiftKey ? KEY_STEP_BIG : KEY_STEP) * dirOf(id);
        const w = lay.w[id];
        const targets = { ArrowRight: w + step, ArrowLeft: w - step, Home: c.min, End: Cols.maxFor(id, lay) };
        if (e.key === 'Enter') {
          e.preventDefault();
          fitColumn(id);
        } else if (Object.hasOwn(targets, e.key)) {
          e.preventDefault(); // also keeps Home / End / arrows from the graph's navigation
          resizeColumn(id, targets[e.key]);
        }
      }
      function onHeaderDblClick(e) {
        const r = handleOf(e);
        if (r) fitColumn(r.dataset.col);
      }
      header.addEventListener('pointerdown', onPointerDown);
      header.addEventListener('pointermove', onPointerMove);
      header.addEventListener('pointerup', endDrag);
      header.addEventListener('pointercancel', endDrag);
      header.addEventListener('lostpointercapture', endDrag);
      header.addEventListener('keydown', onHeaderKey);
      header.addEventListener('dblclick', onHeaderDblClick);

      body.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        const r = e.target.closest('.gv-row');
        if (!r || r.dataset.index === undefined) return;
        const row = S.rows[Number(r.dataset.index)];
        if (!row) return;
        e.preventDefault(); // no text selection; keep focus handling below
        scroller.focus({ preventScroll: true });
        selectLocal(() => store.actions.select(row.kind === 'wip' ? { kind: 'wip' } : { kind: 'commit', sha: row.commit.hash }));
      });

      // Double-click on a local branch pill checks it out (the mousedown above keeps text unselected).
      function onDblClick(e) {
        const pill = e.target.closest && e.target.closest('.gv-pill');
        const r = pill && pill.closest('.gv-row');
        if (!r || !body.contains(r)) return;
        const d = pillAction(r._p.pill, S);
        if (d) runFlow(d, store);
      }
      body.addEventListener('dblclick', onDblClick);

      // Context menu: right-click selects the row and opens its menu (on a ref pill: that ref's menu,
      // the same as its sidebar row); the ContextMenu key / Shift+F10 opens the selected row's menu.
      // Targets are row indexes, or {i, pill} for a pill. On the column header (right-click, or the
      // key on a focused separator) the target is 'header': Reset column widths.
      const indexOf = (t) => (typeof t === 'number' ? t : t.i);
      const unbindMenu = bindContextMenu(scroller, {
        targetOf(e) { // NOSONAR(S3800): 'header', a row index, {i, pill} or null, as bindContextMenu expects
          if (e.target && e.target.nodeType === 1 && header.contains(e.target)) return 'header';
          if (e.type === 'keydown') return selIdx >= 0 ? selIdx : null;
          const r = e.target.closest && e.target.closest('.gv-row');
          if (!r || !body.contains(r) || r.dataset.index === undefined) return null;
          const i = Number(r.dataset.index);
          if (!S.rows[i]) return null;
          const onPill = e.target.closest('.gv-pill');
          return onPill && r._p && pillTarget(r._p.pill, S.rows[i].commit && S.rows[i].commit.hash) ? { i, pill: r._p.pill } : i;
        },
        anchorOf: (t, e) => (t === 'header' ? e.target : bound.get(indexOf(t)) || scroller),
        itemsFor(t, e) {
          if (t === 'header') {
            const same = prefs.isDefault();
            return [{ label: 'Reset column widths', action: () => prefs.reset(), disabled: same, title: same ? 'The columns already have their default widths' : undefined }];
          }
          const i = indexOf(t);
          const row = S.rows[i];
          if (!row) return [];
          if (e.type === 'keydown') {
            revealSelection();
            render();
          } else {
            scroller.focus({ preventScroll: true });
            selectLocal(() => store.actions.select(row.kind === 'wip' ? { kind: 'wip' } : { kind: 'commit', sha: row.commit.hash }));
          }
          return toMenuItems(typeof t === 'number' ? commitMenuItems(row, S) : pillMenuItems(t.pill, row, S), store);
        },
      });

      // Navigation keys belong to the graph when it has focus, when nothing does (focus on body after
      // a click on inert chrome) or when a toolbar button does (e.g. Undo just clicked) — never to
      // another panel's button, a row, list, tree or menu with its own keys (ownsNavKeys). They are
      // navigation, so a held key repeats (the Components.actions.KEYS repeat policy).
      const graphOwnsKeys = () => ownsNavKeys(document.activeElement, scroller);
      function onKey(e) {
        // Local handlers elsewhere claim a key with preventDefault(); modifiers belong to app shortcuts.
        if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
        if (inTextField(e) || modalOpen() || !graphOwnsKeys()) return;
        if (!root.isConnected || root.hidden || !root.offsetParent) return; // graph hidden (e.g. diff open)
        if (!S.rows.length) return;
        const page = Math.max(1, Math.floor((scroller.clientHeight - bodyTop) / ROW_H) - 2);
        const keys = { j: 1, ArrowDown: 1, k: -1, ArrowUp: -1, Home: -S.rows.length, End: S.rows.length, PageDown: page, PageUp: -page };
        if (!Object.hasOwn(keys, e.key)) return;
        e.preventDefault();
        if (!scroller.contains(document.activeElement)) scroller.focus({ preventScroll: true }); // announce via activedescendant
        selectLocal(() => store.actions.selectRelative(keys[e.key]));
      }
      window.addEventListener('keydown', onKey);

      // relative dates drift; refresh them once a minute
      const clock = setInterval(() => { renderGen++; render(); }, 60000);

      bodyTop = body.offsetTop;
      avail = scroller.clientWidth || 0;
      updateGraphWidth();
      updateEmpty();
      selIdx = selIndex();
      render();

      return () => {
        disposed = true;
        unsub();
        unsubCentre();
        unsubPrefs();
        ro.disconnect();
        clearInterval(clock);
        window.removeEventListener('keydown', onKey);
        body.removeEventListener('dblclick', onDblClick);
        unbindMenu();
        root.replaceChildren();
        for (const c of Cols.COLUMNS) {
          root.style.removeProperty(`--gv-${c.id}-w`);
          root.classList.remove(`gv-hide-${c.id}`);
        }
        root.classList.remove('gv-graph-clipped', 'gv-resizing');
      };
    },
  });

  if (typeof module !== 'undefined') module.exports = { refPills, rowView, commitMenuItems, pillTarget, pillMenuItems, pillAction, ownsNavKeys, ROW_H, PAGE_AHEAD_PX };
})();
