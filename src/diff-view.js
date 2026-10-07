'use strict';
// The diff view the renderer shows (it can't run hunks.js): a latin1 patch from git parsed,
// decoded for display and capped (lines, characters, bytes), with the staging fingerprint; plus
// the guard that refuses a hunk / line selection reaching past what the view showed. Pure: it
// takes git's text and never runs git (ops.js does), so it is unit-tested with made-up patches.
const { kindError } = require('./exec');
const hunks = require('./hunks');

const invalid = (msg) => kindError('invalid-args', msg);

// Display caps for diff views. Past any of them the rest is dropped and `truncated` is set.
/** Max diff lines sent to the renderer (across all sections / conflict hunks). */
const DIFF_VIEW_MAX_LINES = 20000;
/** Max display chars per line; longer lines are clipped and flagged `clipped: true`. */
const DIFF_VIEW_MAX_LINE_CHARS = 10000;
/** Max display chars across the whole view (after per-line clipping). */
const DIFF_VIEW_MAX_CHARS = 5_000_000;
/** Max raw patch bytes parsed for display; past this the fingerprint is null (it'd be partial). */
const DIFF_VIEW_MAX_RAW = 50 * 1024 * 1024;

/**
 * Turn a latin1 patch from git.diffWorkdir / git.diffCommitFile into a display-ready view:
 *   { file, sections, fingerprint, truncated, maxLines, maxLineChars, conflict }
 * - `sections`: every file section of the patch (a typechange, e.g. file -> symlink, is two:
 *   a deletion and a new file). Each has the parsed header fields and `hunks`; `file` is
 *   sections[0] (or null when there is no diff).
 * - Line `text` is decoded for display (UTF-8 when valid, else Latin-1), a trailing CR is
 *   stripped and reported as `cr: true`, and text over DIFF_VIEW_MAX_LINE_CHARS is clipped
 *   (`clipped: true`).
 * - `fingerprint` (what stage/unstage/discardSelection accept) is set only when the patch is
 *   exactly one non-binary section parsed in full; the display caps don't affect it.
 * - `truncated`: some lines or sections were dropped by a cap. A hunk that lost lines has
 *   `truncated: true`; its header and oldLines/newLines are kept as git printed them, so the
 *   counts may exceed the lines present (M4 must refuse hunk/line actions on such hunks).
 * - `fingerprint: false` (option): never compute one (rename views, see workdirDiffView).
 * - `conflict`: for an unmerged path git prints a combined diff (`diff --cc`); then `file` is
 *   null, `sections` empty, `fingerprint` null and conflict is { path, hunks: [{ header,
 *   truncated?, lines: [{ prefix, text, cr, clipped?, noNewlineAtEof? }] }], isBinary? } where `prefix`
 *   is the one-char-per-parent column string (e.g. '++', ' -', '- '). A conflict git can't
 *   show as a combined diff (e.g. modify/delete: git prints only "* Unmerged path f") is
 *   { path: requestedPath, hunks: [] }.
 */
function diffView(raw, requestedPath = null, { fingerprint: withFingerprint = true } = {}) {
  const cap = {
    lines: DIFF_VIEW_MAX_LINES, chars: DIFF_VIEW_MAX_CHARS, truncated: false,
    // Room for one more line / hunk / section? A refusal means something is dropped.
    take() {
      if (this.lines > 0 && this.chars > 0) return true;
      this.truncated = true;
      return false;
    },
  };
  const rawCut = raw.length > DIFF_VIEW_MAX_RAW;
  if (rawCut) {
    const nl = raw.lastIndexOf('\n', DIFF_VIEW_MAX_RAW);
    raw = raw.slice(0, nl > 0 ? nl + 1 : DIFF_VIEW_MAX_RAW);
    cap.truncated = true;
  }
  const result = (o) => ({
    file: null, sections: [], fingerprint: null, conflict: null, ...o,
    truncated: cap.truncated, maxLines: DIFF_VIEW_MAX_LINES, maxLineChars: DIFF_VIEW_MAX_LINE_CHARS,
  });

  if (raw.startsWith('* Unmerged path ')) return result({ conflict: { path: requestedPath, hunks: [] } });
  if (raw.startsWith('diff --cc ') || raw.startsWith('diff --combined ')) {
    const conflict = combinedDiffView(raw, cap);
    if (rawCut && conflict.hunks.length) conflict.hunks[conflict.hunks.length - 1].truncated = true;
    return result({ conflict });
  }

  const files = hunks.parsePatch(raw, { encoding: 'latin1' });
  const sections = [];
  for (const f of files) {
    if (!cap.take()) break;
    const view = {
      oldPath: f.oldPath, newPath: f.newPath, isNew: f.isNew, isDeleted: f.isDeleted,
      isBinary: f.isBinary, isRename: f.isRename, isCopy: f.isCopy, oldMode: f.oldMode, newMode: f.newMode,
      hunks: [],
    };
    sections.push(view);
    for (const h of f.hunks) {
      if (!cap.take()) break;
      const hunk = { header: h.header, oldStart: h.oldStart, oldLines: h.oldLines, newStart: h.newStart, newLines: h.newLines, lines: [] };
      view.hunks.push(hunk);
      for (const l of h.lines) {
        if (!cap.take()) { hunk.truncated = true; break; }
        hunk.lines.push({ type: l.type, ...displayText(l.text, cap), oldNo: l.oldNo, newNo: l.newNo, noNewlineAtEof: l.noNewlineAtEof });
      }
    }
  }
  if (rawCut) {
    const last = sections[sections.length - 1]?.hunks.at(-1);
    if (last) last.truncated = true; // the cut may have ended it early
  }
  const single = withFingerprint && !rawCut && files.length === 1 && !files[0].isBinary;
  return result({ file: sections[0] || null, sections, fingerprint: single ? hunks.fingerprint(files[0]) : null });
}

/**
 * Display form of one latin1 line body: { text, cr, clipped? }. Only a bounded prefix is
 * decoded (a 30 MB line never becomes a 30 MB string), cut back to a UTF-8 char boundary.
 * Charges the cap one line and the kept chars.
 */
function displayText(bytes, cap) {
  const cr = bytes.endsWith('\r');
  if (cr) bytes = bytes.slice(0, -1);
  let clipped = false;
  const maxBytes = DIFF_VIEW_MAX_LINE_CHARS * 4; // enough for MAX_LINE_CHARS UTF-8 chars
  if (bytes.length > maxBytes) {
    let end = maxBytes;
    // Drop a possibly incomplete UTF-8 sequence at the cut (continuation bytes + their lead).
    let j = end - 1;
    while (j > end - 4 && (bytes.charCodeAt(j) & 0xc0) === 0x80) j--;
    if (bytes.charCodeAt(j) >= 0xc0) end = j;
    bytes = bytes.slice(0, end);
    clipped = true;
  }
  let text = hunks.decodeForDisplay(bytes);
  const max = Math.min(DIFF_VIEW_MAX_LINE_CHARS, Math.max(cap.chars, 0));
  if (text.length > max) {
    text = text.slice(0, max);
    if (/[\ud800-\udbff]$/.test(text)) text = text.slice(0, -1); // don't split a surrogate pair
    clipped = true;
  }
  cap.lines--;
  cap.chars -= text.length;
  if (clipped && cap.chars <= 0) cap.truncated = true;
  return clipped ? { text, cr, clipped } : { text, cr };
}

const COMBINED_HUNK_RE = /^(@{3,}) [^@]*\1/;

/**
 * Minimal parser for git's combined diff of one unmerged path (`diff --cc`): header lines,
 * then hunks `@@@ -a,b -c,d +e,f @@@` (N parents -> N+1 '@'), each line prefixed by N columns
 * of ' ', '+' or '-'. Shown read-only, so line counts are not tracked. A binary file has no
 * hunks, only "Binary files differ": `isBinary: true` (the image preview shows its stages).
 */
function combinedDiffView(raw, cap) {
  const lines = raw.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  // Reuse hunks.js path decoding (C-quoting, bytes) via the ---/+++ lines when present.
  const head = [];
  let binary = false;
  let i = 1;
  for (; i < lines.length && !COMBINED_HUNK_RE.test(lines[i]); i++) {
    if (/^(---|\+\+\+) /.test(lines[i])) head.push(lines[i]);
    else if (lines[i].startsWith('Binary files ')) binary = true;
  }
  const hf = head.length === 2 ? hunks.parsePatch(`${head.join('\n')}\n`, { encoding: 'latin1' })[0] : null;
  const path = hf?.newPath ?? hf?.oldPath ?? hunks.decodeForDisplay(lines[0].replace(/^diff --(cc|combined) /, ''));
  const conflict = binary ? { path, hunks: [], isBinary: true } : { path, hunks: [] };
  let hunk = null, n = 0;
  for (; i < lines.length; i++) {
    const l = lines[i];
    const m = l.match(COMBINED_HUNK_RE);
    if (m) {
      if (!cap.take()) break;
      n = m[1].length - 1;
      hunk = { header: l, lines: [] };
      conflict.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (l.startsWith('\\')) { // "\ No newline at end of file" applies to the previous line
      const prev = hunk.lines[hunk.lines.length - 1];
      if (prev) prev.noNewlineAtEof = true;
      continue;
    }
    const prefix = l.slice(0, n);
    if (prefix.length < n || /[^ +-]/.test(prefix)) { hunk = null; continue; } // not a hunk line
    if (hunk.truncated) continue;
    if (!cap.take()) { hunk.truncated = true; continue; }
    hunk.lines.push({ prefix, ...displayText(l.slice(n), cap) });
  }
  return conflict;
}

/**
 * hunks.js `checkPatch` hook for stage/unstage/discardSelection: the renderer can only select
 * what diffView sent it, so refuse (kind 'invalid-args', "hunk is truncated in the view") a
 * selection reaching past it in the freshly computed diff `raw` / `patch`:
 * - a whole-hunk selection of a hunk the view truncated (lost lines) or dropped entirely;
 * - a line index at or past the number of lines the view had for that hunk.
 * The view is recomputed with diffView itself, so the caps can never disagree. Clipped (over-long)
 * lines are shown, flagged `clipped`, so they stay selectable. Indices that don't exist in the
 * patch at all are left to hunks.js (kind 'stale').
 */
function refuseTruncated(raw, patch, sel) {
  if (!mayTruncate(raw)) return;
  const shown = diffView(raw).sections[0];
  for (const s of sel) {
    const h = patch.hunks[s.hunk];
    if (!h) continue;
    const v = shown ? shown.hunks[s.hunk] : undefined;
    const count = v ? v.lines.length : 0;
    const bad = s.lines == null
      ? !v || v.truncated === true
      : s.lines.some((li) => Number.isInteger(li) && li >= count && li < h.lines.length);
    if (bad) throw invalid('hunk is truncated in the view');
  }
}

/**
 * False when no diffView cap can drop anything from `raw`: at most MAX_LINES lines and at most
 * MAX_CHARS bytes (display text never has more UTF-16 units than bytes). Skips re-rendering
 * ordinary diffs.
 */
function mayTruncate(raw) {
  if (raw.length > DIFF_VIEW_MAX_CHARS) return true;
  let n = 0;
  for (let i = raw.indexOf('\n'); i >= 0; i = raw.indexOf('\n', i + 1)) if (++n > DIFF_VIEW_MAX_LINES) return true;
  return false;
}

module.exports = {
  DIFF_VIEW_MAX_LINES, DIFF_VIEW_MAX_LINE_CHARS, DIFF_VIEW_MAX_CHARS, DIFF_VIEW_MAX_RAW,
  diffView, displayText, combinedDiffView, refuseTruncated, mayTruncate,
};
