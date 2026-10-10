'use strict';
// The `git clone --progress` stderr parser (src/clone-progress.js), on stderr captured from git
// 2.51.2 (test/fixtures/clone/: a file:// clone, an empty repository, a local path, a 61 MiB
// transfer with throughput) and a small transfer in git's `bytes` units (written by hand in git's
// format: a transfer that small never runs long enough for git to print its throughput).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createProgressParser, _internal: { parseFrame, amountOf } } = require('../src/clone-progress');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', 'clone', `${name}.stderr`));
const parseAll = (buf, o) => {
  const p = createProgressParser(o);
  return { frames: [...p.feed(buf), ...p.end()], lines: p.lines() };
};
const ch = (n) => String.fromCharCode(n);

test('a file:// clone: every phase in order, percent to 100, done, remote phases marked', () => {
  const { frames, lines } = parseAll(fixture('file-url'));
  const phases = [...new Set(frames.map((f) => `${f.remote ? 'remote ' : ''}${f.phase}`))];
  assert.deepEqual(phases, ['remote Enumerating objects', 'remote Counting objects', 'remote Compressing objects', 'Receiving objects', 'Resolving deltas']);
  assert.deepEqual(frames[0], { phase: 'Enumerating objects', percent: null, current: 35, total: null, bytes: null, rate: null, done: true, remote: true });
  const receiving = frames.filter((f) => f.phase === 'Receiving objects');
  assert.deepEqual(receiving.at(-1), { phase: 'Receiving objects', percent: 100, current: 35, total: 35, bytes: null, rate: null, done: true, remote: false });
  assert.ok(receiving.every((f, i) => i === 0 || f.percent >= receiving[i - 1].percent), 'percent never goes back');
  assert.equal(frames.at(-1).phase, 'Resolving deltas');
  assert.equal(frames.at(-1).done, true);
  assert.deepEqual(lines, ["Cloning into 'out1'...", 'remote: Total 35 (delta 1), reused 0 (delta 0), pack-reused 0 (from 0)'],
    'the text lines only, trailing padding trimmed: never the progress frames');
});

test('throughput in KiB / MiB, and in bytes for small transfers', () => {
  const big = parseAll(fixture('throughput')).frames.filter((f) => f.bytes !== null);
  assert.ok(big.length > 0);
  assert.deepEqual(big.at(-1), { phase: 'Receiving objects', percent: 100, current: 10, total: 10, bytes: Math.round(61.05 * 1024 ** 2), rate: Math.round(58.87 * 1024 ** 2), done: true, remote: false });
  const small = parseAll(fixture('small-bytes')).frames.filter((f) => f.phase === 'Receiving objects');
  assert.deepEqual(small.map((f) => [f.percent, f.bytes, f.rate, f.done]), [[33, 512, 1024 * 1024, false], [66, 900, 600, false], [100, Math.round(1.05 * 1024), 700, true]]);
  assert.equal(amountOf('3 GiB'), 3 * 1024 ** 3);
  assert.equal(amountOf('1.5 TiB'), 1.5 * 1024 ** 4);
  assert.equal(amountOf(undefined), null);
});

test('an empty repository and a local path: no frames, and the warning kept as a line', () => {
  const empty = parseAll(fixture('empty'));
  assert.deepEqual(empty.frames, []);
  assert.deepEqual(empty.lines, ["Cloning into 'out2'...", 'warning: You appear to have cloned an empty repository.']);
  const local = parseAll(fixture('local-path'));
  assert.deepEqual(local.frames, [], 'the local fast path prints no progress');
  assert.deepEqual(local.lines, ["Cloning into 'out3'...", 'done.']);
});

test('chunks split at every byte offset give the same frames and lines, multi-byte characters included', () => {
  const text = Buffer.concat([fixture('small-bytes'), Buffer.from("remote: caf\u00e9 \u2713 r\u00e9po\nfatal: d\u00e9j\u00e0 vu\n")]);
  const whole = parseAll(text);
  assert.ok(whole.lines.some((l) => l === 'remote: caf\u00e9 \u2713 r\u00e9po'));
  for (let i = 1; i < text.length; i++) {
    const p = createProgressParser();
    const frames = [...p.feed(text.subarray(0, i)), ...p.feed(text.subarray(i)), ...p.end()];
    assert.deepEqual(frames, whole.frames, `split at ${i}`);
    assert.deepEqual(p.lines(), whole.lines, `split at ${i}`);
  }
  // One byte at a time.
  const p = createProgressParser();
  const frames = [];
  for (const b of text) frames.push(...p.feed(Buffer.from([b])));
  frames.push(...p.end());
  assert.deepEqual(frames, whole.frames);
  assert.deepEqual(p.lines(), whole.lines);
});

test('\\r\\n endings (Windows) count as one break, also split across chunks', () => {
  const text = 'Cloning into \'x\'...\r\nReceiving objects:  50% (1/2)\rReceiving objects: 100% (2/2), done.\r\nwarning: w\r\n';
  const whole = parseAll(Buffer.from(text));
  assert.deepEqual(whole.lines, ["Cloning into 'x'...", 'warning: w'], 'no empty lines');
  assert.deepEqual(whole.frames.map((f) => f.percent), [50, 100]);
  const cut = text.indexOf('\r\n') + 1; // between '\r' and '\n'
  const p = createProgressParser();
  const frames = [...p.feed(Buffer.from(text.slice(0, cut))), ...p.feed(Buffer.from(text.slice(cut))), ...p.end()];
  assert.deepEqual(frames, whole.frames);
  assert.deepEqual(p.lines(), whole.lines);
});

test('only the known phases are progress: other remote: text and look-alikes are kept as lines', () => {
  for (const line of ['remote: Repository not found.', 'remote: Counting stars: 50% (1/2)', 'Receiving objects', 'Receiving objects: lots',
    'error: Receiving objects: 50% (1/2) failed', 'Receiving objects:  50% (1/2) and more']) {
    assert.equal(parseFrame(line), null, line);
  }
  const { frames, lines } = parseAll(Buffer.from('remote: Counting stars: 50% (1/2)\nUpdating files:  10% (2/20)\rFiltering content:  50% (1/2), 1.00 KiB | 2.00 KiB/s\rChecking connectivity: 30, done.\n'));
  assert.deepEqual(frames.map((f) => f.phase), ['Updating files', 'Filtering content', 'Checking connectivity']);
  assert.deepEqual(lines, ['remote: Counting stars: 50% (1/2)']);
});

test('the ring keeps the last maxLines lines, each cut to maxLine, invisible characters removed', () => {
  const text = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
  assert.deepEqual(parseAll(Buffer.from(text), { maxLines: 3 }).lines, ['line 27', 'line 28', 'line 29']);
  assert.deepEqual(parseAll(Buffer.from(`${'x'.repeat(50)}\n`), { maxLine: 10 }).lines, ['x'.repeat(10)]);
  const evil = `remote: ok${ch(0x1b)}[31m red${ch(0x202e)}txt${ch(0x07)}\n`;
  assert.deepEqual(parseAll(Buffer.from(evil)).lines, ['remote: ok[31m redtxt']);
  assert.equal(parseAll(Buffer.from('')).lines.length, 0);
  // The default caps: 20 lines of at most 500 characters.
  const many = parseAll(Buffer.from(Array.from({ length: 25 }, () => 'y'.repeat(600)).join('\n'))).lines;
  assert.equal(many.length, 20);
  assert.ok(many.every((l) => l.length === 500));
});

test('a string chunk is taken as text (the parser is also fed strings by tests)', () => {
  const p = createProgressParser();
  assert.deepEqual(p.feed('Resolving deltas: 100% (1/1), done.\n').map((f) => f.done), [true]);
  assert.deepEqual(p.end(), []);
});
