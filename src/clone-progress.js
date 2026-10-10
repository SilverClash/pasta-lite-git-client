'use strict';
// The stderr of `git clone --progress` (docs/plans/clone-repository.md §5.2): '\r'-separated
// progress frames ("Receiving objects:  45% (16/35), 12.30 MiB | 4.10 MiB/s") and '\n'-terminated
// lines ("Cloning into…", "warning: …", "fatal: …", the server's "remote: …"). Pure: src/clone.js
// feeds it git's stderr chunks as they arrive.
//
// createProgressParser({maxLines, maxLine}) -> {feed(chunk) -> CloneProgress[], end() ->
// CloneProgress[], lines() -> string[]}. A CloneProgress is {phase, percent, current, total,
// bytes, rate, done, remote}: the numbers null when git didn't print them, `bytes` and `rate`
// (per second) in bytes. Every other non-empty frame goes into a ring of the last `maxLines`
// lines, each cut to `maxLine` characters with the invisible characters removed: lines() is what
// the error message and its classification are built from, never the whole stderr (hundreds of
// progress frames).
//
// git's English is guaranteed by LC_ALL=C (src/git-process.js baseEnv). The phases are a closed
// set: anything else is text, not progress. `remote:` lines are the server's own text; a hostile
// server can print a fake phase, which only moves the bar.
const { StringDecoder } = require('node:string_decoder');
const { INVISIBLE } = require('./display-text');

const PHASES = ['Enumerating objects', 'Counting objects', 'Compressing objects', 'Receiving objects',
  'Resolving deltas', 'Updating files', 'Filtering content', 'Checking connectivity'];

// "<phase>: <pct>% (<a>/<b>)" or "<phase>: <n>" (a count without a total: "Enumerating objects:
// 35, done."; a phase name alone is no frame), then git's throughput ", <amount> | <rate>/s"
// (shown once a transfer takes over half a second; amounts under 1 KiB in bytes), then ", done.".
// git pads `remote:` frames with trailing spaces, which are trimmed first.
const AMOUNT = '([\\d.]+ (?:bytes|[KMGT]iB))';
const FRAME = new RegExp(`^(remote: )?(${PHASES.join('|')})`
  + ': +(?:(\\d+)% \\((\\d+)\\/(\\d+)\\)|(\\d+))'
  + `(?:, ${AMOUNT})?`
  + `(?: \\| ${AMOUNT}\\/s)?`
  + '(, done\\.)?$');

const UNIT = { bytes: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4 };

/** "12.30 MiB" -> bytes (a whole number), or null. */
function amountOf(s) {
  if (!s) return null;
  const [n, unit] = s.split(' ');
  const v = Number(n) * UNIT[unit];
  return Number.isFinite(v) ? Math.round(v) : null;
}

const int = (s) => (s === undefined ? null : Number(s));

/** One frame (trailing spaces trimmed) as a CloneProgress, or null when it isn't one. */
function parseFrame(frame) {
  const m = FRAME.exec(frame);
  if (!m) return null;
  const [, remote, phase, percent, current, total, count, bytes, rate, done] = m;
  return {
    phase,
    percent: int(percent),
    current: int(current !== undefined ? current : count),
    total: int(total),
    bytes: amountOf(bytes),
    rate: amountOf(rate),
    done: !!done,
    remote: !!remote,
  };
}

/** A progress parser over one command's stderr (see the header). */
function createProgressParser({ maxLines = 20, maxLine = 500 } = {}) {
  const decoder = new StringDecoder('utf8');
  const ring = [];
  let pending = ''; // text after the last break
  let skipLf = false; // the last chunk ended in '\r': a '\n' starting the next one is the same break

  const take = (frame, out) => {
    const text = frame.replace(/\s+$/, '');
    if (!text) return;
    const p = parseFrame(text);
    if (p) {
      out.push(p);
      return;
    }
    ring.push(text.replace(INVISIBLE, '').slice(0, maxLine));
    if (ring.length > maxLines) ring.shift();
  };

  const scan = (text, out) => {
    let s = text;
    if (skipLf && s.startsWith('\n')) s = s.slice(1);
    skipLf = false;
    s = pending + s;
    let start = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c !== '\r' && c !== '\n') continue;
      take(s.slice(start, i), out);
      if (c === '\r') {
        if (i + 1 < s.length && s[i + 1] === '\n') i++;
        else if (i + 1 === s.length) skipLf = true;
      }
      start = i + 1;
    }
    pending = s.slice(start);
  };

  return {
    /** The frames complete in `chunk` (a Buffer or a string), in order. */
    feed(chunk) {
      const out = [];
      scan(typeof chunk === 'string' ? chunk : decoder.write(chunk), out);
      return out;
    },
    /** The frames of what is left (stderr ended without a final break). */
    end() {
      const out = [];
      scan(decoder.end(), out);
      take(pending, out);
      pending = '';
      return out;
    },
    /** The last `maxLines` text lines (not progress), oldest first. */
    lines: () => [...ring],
  };
}

module.exports = { createProgressParser, PHASES, _internal: { parseFrame, amountOf } }; // _internal: for unit tests only
