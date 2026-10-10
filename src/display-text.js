/*
 * Pasta Lite - text that is safe to show: the invisible and control characters a name, a path or
 * a server's message may carry, and how they are made visible. Moved here from
 * renderer/components.js (which loads it as Components.util.displayName), so that main's clone
 * parsers (src/clone-url.js, src/clone-progress.js) strip the very same class.
 *
 * Pure, dependency-free. Works in Node (`require('./src/display-text.js')`) and in the browser as a
 * plain <script> (exposes `window.PLDisplayText`), like src/error-kinds.js.
 *
 * INVISIBLE and JOINERS (global RegExps: use them with replace / search, not test),
 * hasInvisible(s, {joiners}), displayName(s).
 */
(function (exports) {
  'use strict';

  // Bidi controls (can reorder text: "rtl\u202Egnp.js" would show as "rtlsj.png"), C0/C1 control
  // characters (newlines, tabs, escape), and the zero-width and format characters that hide in a
  // name or a URL (zero-width space, word joiner and the invisible operators, the BOM, the soft
  // hyphen, the Mongolian vowel separator, the interlinear annotation marks) are made visible.
  const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\ufff9-\ufffb]/g;
  // The zero-width non-joiner and joiner are left as they are in shown text (emoji sequences and
  // Persian or Indic words need them), but hasInvisible({joiners: true}) counts them: a URL or a
  // folder name has no use for them, and there they only hide a character.
  const JOINERS = /[\u200c\u200d]/g;

  /**
   * True when `s` has a character of INVISIBLE (search: the global regexes keep no state here);
   * `joiners`: also one of JOINERS (a URL, a folder name).
   */
  const hasInvisible = (s, { joiners = false } = {}) => String(s).search(INVISIBLE) >= 0 || (joiners && String(s).search(JOINERS) >= 0);

  /** Text safe to show as a name/path: dangerous or invisible characters become visible escapes. */
  const displayName = (s) => String(s == null ? '' : s).replace(INVISIBLE, (c) => {
    if (c === '\n') return '\u21b5'; // ↵
    if (c === '\t') return '\u21e5'; // ⇥
    return `\\u{${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}}`;
  });

  exports.INVISIBLE = INVISIBLE;
  exports.JOINERS = JOINERS;
  exports.hasInvisible = hasInvisible;
  exports.displayName = displayName;
})(typeof module !== 'undefined' ? module.exports : (window.PLDisplayText = {})); // NOSONAR(S1121): the CommonJS-or-window export idiom
