'use strict';
// src/image-format.js: the catalogue, content sniffing (mislabeled files included), header
// dimensions, Git LFS pointers, and hostile bytes (truncations, loops, odd box sizes). Fixtures
// are built here byte by byte; the last test checks the demo repository's real image files
// (test/fixtures/images) too.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const F = require('../src/image-format');
const {
  bytes, u16le, u16be, u32le, u32be, pngChunk, png, jpeg, gif, webpVp8, webpVp8l, webpVp8x, box, fullBox, ftyp, ispe, isobmff, irot, pitm, ipma, heif,
  bmp, ico, psd, tiff, svg,
} = require('./image-fixtures');

const { sniff, dimensions, parseLfsPointer, FORMATS, POLICY } = F;

const FIXTURES = {
  png: png(4, 3),
  jpeg: jpeg(640, 480, { exif: true }),
  gif: gif(5, 6),
  webp: webpVp8x(300, 200),
  avif: isobmff(['avif', 'mif1', 'miaf'], 64, 32),
  bmp: bmp(7, 9),
  ico: ico([[16, 16], [0, 0]]),
  svg: svg('<?xml version="1.0"?>\n'),
  heic: isobmff(['heic', 'mif1', 'heic'], 4032, 3024),
  tiff: bytes('II*\0', u32le(8), Buffer.alloc(32)),
  psd: psd(800, 600),
  jxl: bytes([0xff, 0x0a, 0xfa, 0x7f, 0x01], Buffer.alloc(16)),
};

// ---------------------------------------------------------------- catalogue

test('the catalogue: tiers, MIME types only for tier 1, frozen, extensions map to one format', () => {
  const tier1 = ['png', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg'];
  for (const [id, f] of Object.entries(FORMATS)) {
    assert.equal(f.id, id);
    assert.ok(Object.isFrozen(f) && Object.isFrozen(f.extensions), id);
    assert.equal(f.tier === 1, tier1.includes(id), id);
    assert.equal(typeof f.mime === 'string', f.tier === 1, `${id}: a MIME type only for what Chromium decodes`);
  }
  assert.deepEqual(Object.values(FORMATS).filter((f) => f.tier === 2).map((f) => f.id).sort(), ['heic', 'psd', 'svgz', 'tiff']);
  assert.equal(FORMATS.jxl.tier, 'probe');
  assert.equal(FORMATS.webp.mime, 'image/webp');
  assert.equal(FORMATS.svg.mime, 'image/svg+xml');
  assert.equal(FORMATS.ico.mime, 'image/x-icon');
  const exts = Object.values(FORMATS).flatMap((f) => f.extensions);
  assert.equal(new Set(exts).size, exts.length, 'no extension in two formats');
  assert.ok(Object.isFrozen(FORMATS));
});

test('POLICY: the agreed limits, frozen', () => {
  assert.ok(Object.isFrozen(POLICY));
  assert.deepEqual({ ...POLICY }, {
    sniffBytes: 64 * 1024, softMaxBytes: 20 * 1024 * 1024, maxBytes: 50 * 1024 * 1024,
    svgMaxBytes: 5 * 1024 * 1024, maxPixels: 100000000, lfsPointerMax: 1024,
  });
  assert.equal(POLICY.maxBytes, require('../src/diff-view').DIFF_VIEW_MAX_RAW, 'the hard cap is the diff view\'s');
});

test('the UMD file works as a plain browser script (window.PLImageFormat)', () => {
  const vm = require('node:vm');
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'image-format.js'), 'utf8'), { window });
  assert.equal(window.PLImageFormat.FORMATS.webp.label, 'WebP');
  assert.equal(window.PLImageFormat.formatOfPath('a/b.WEBP'), 'webp');
  assert.equal(window.PLImageFormat.sniff(new Uint8Array(FIXTURES.png)).format, 'png');
});

test('extensionOf / formatOfPath: the base name\'s last extension, lower-cased', () => {
  assert.equal(F.extensionOf('a/b/Photo.JPG'), 'jpg');
  assert.equal(F.extensionOf('dir.png/file'), null);
  assert.equal(F.extensionOf('a\\b.Png'), 'png');
  assert.equal(F.extensionOf('.png'), null, 'a dot file has no extension');
  assert.equal(F.extensionOf('x.'), null);
  assert.equal(F.extensionOf('x.tar.gz'), 'gz');
  assert.equal(F.extensionOf(undefined), null);
  assert.equal(F.formatOfPath('icon.cur'), 'ico');
  assert.equal(F.formatOfPath('a.heif'), 'heic');
  assert.equal(F.formatOfPath('a.txt'), null);
  assert.equal(F.formatOfPath('toString'), null);
  assert.equal(F.formatOfPath('a.constructor'), null);
});

// ---------------------------------------------------------------- sniffing

test('sniff: every catalogued format from its magic bytes', () => {
  for (const [id, b] of Object.entries(FIXTURES)) {
    const m = sniff(b, { path: `x.${FORMATS[id].extensions[0]}` });
    assert.equal(m.format, id, id);
    assert.equal(m.byContent, true);
    assert.equal(m.mismatch, false, id);
    assert.equal(m.extensionHint, id);
  }
  const variants = {
    'png (apng)': [png(2, 2, { apng: true }), 'png'],
    'webp VP8': [webpVp8(10, 10), 'webp'],
    'webp VP8L': [webpVp8l(10, 10), 'webp'],
    'avif sequence': [isobmff(['avis', 'avif', 'msf1'], 8, 8), 'avif'],
    'avif as a compatible brand': [isobmff(['mif1', 'miaf', 'avif'], 8, 8), 'avif'],
    'heic via mif1': [isobmff(['mif1', 'heic'], 8, 8), 'heic'],
    'heic msf1 + hevc': [isobmff(['msf1', 'hevc'], 8, 8), 'heic'],
    cur: [ico([[32, 32]], 2), 'ico'],
    'tiff MM': [bytes('MM\0*', u32be(8), Buffer.alloc(16)), 'tiff'],
    'BigTIFF II': [bytes('II+\0', Buffer.alloc(16)), 'tiff'],
    'BigTIFF MM': [bytes('MM\0+', Buffer.alloc(16)), 'tiff'],
    psb: [psd(10, 10, 2), 'psd'],
    'jxl container': [bytes([0, 0, 0, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a], Buffer.alloc(20)), 'jxl'],
    'bmp core header': [bmp(3, 3, 12), 'bmp'],
    'bmp v5': [bmp(3, 3, 124), 'bmp'],
    'jpeg SOF2': [jpeg(10, 10, { sof: 0xc2 }), 'jpeg'],
    gif87a: [bytes('GIF87a', gif(1, 1).subarray(6)), 'gif'],
  };
  for (const [what, [b, id]] of Object.entries(variants)) assert.equal(sniff(b).format, id, what);
});

test('sniff: near misses are no format', () => {
  const none = {
    'ftyp without an image brand': isobmff(['isom', 'mp41'], 8, 8),
    'mif1 alone': isobmff(['mif1', 'miaf'], 8, 8),
    'BM with an odd DIB size': bytes('BM', Buffer.alloc(12), u32le(77), Buffer.alloc(30)),
    'ICO with no entries': bytes([0, 0, 1, 0], u16le(0), Buffer.alloc(32)),
    'ICO-like zeros': Buffer.alloc(64),
    '8BPS version 3': psd(10, 10, 3),
    'RIFF but WAVE': bytes('RIFF', u32le(36), 'WAVE', Buffer.alloc(24)),
    'gzip without .svgz': bytes([0x1f, 0x8b, 8, 0], Buffer.alloc(20)),
    empty: Buffer.alloc(0),
    text: Buffer.from('hello world\n'),
  };
  for (const [what, b] of Object.entries(none)) assert.equal(sniff(b, { path: 'x.gz' }).format, null, what);
  assert.equal(sniff(bytes([0x1f, 0x8b, 8, 0], Buffer.alloc(20)), { path: 'logo.svgz' }).format, 'svgz', '.svgz: recognised, unsupported (tier 2)');
  assert.equal(sniff(null).format, null);
  assert.equal(sniff('not bytes').format, null);
  assert.equal(sniff(new Uint8Array(FIXTURES.gif).buffer).format, 'gif', 'an ArrayBuffer');
});

test('sniff: mislabeled files - content decides, the extension is only a hint', () => {
  let m = sniff(FIXTURES.jpeg, { path: 'photos/a.png' });
  assert.deepEqual({ ...m, animated: undefined }, { format: 'jpeg', byContent: true, extensionHint: 'png', mismatch: true, animated: undefined });
  m = sniff(Buffer.from('just some text, not a picture\n'), { path: 'a.webp' });
  assert.equal(m.format, null);
  assert.equal(m.extensionHint, 'webp');
  assert.equal(m.mismatch, false);
  m = sniff(FIXTURES.svg, { path: 'a.jpg' });
  assert.equal(m.format, 'svg');
  assert.equal(m.mismatch, true);
  m = sniff(FIXTURES.png, { path: 'Makefile' });
  assert.deepEqual([m.format, m.extensionHint, m.mismatch], ['png', null, false]);
  m = sniff(FIXTURES.png);
  assert.equal(m.format, 'png');
  m = sniff(png(1, 1, { apng: true }), { path: 'a.apng' });
  assert.equal(m.mismatch, false, 'APNG is PNG');
  m = sniff(FIXTURES.webp, { path: 'a.gif' });
  assert.deepEqual([m.format, m.mismatch], ['webp', true]);
});

test('sniff: animation (APNG, GIF frames, WebP VP8X flag, AVIF sequence)', () => {
  assert.equal(sniff(png(2, 2)).animated, false);
  assert.equal(sniff(png(2, 2, { apng: true })).animated, true);
  assert.equal(sniff(gif(2, 2, 1)).animated, false);
  assert.equal(sniff(gif(2, 2, 3)).animated, true);
  assert.equal(sniff(webpVp8x(5, 5)).animated, false);
  assert.equal(sniff(webpVp8x(5, 5, { animated: true })).animated, true);
  assert.equal(sniff(webpVp8(5, 5)).animated, false);
  assert.equal(sniff(webpVp8l(5, 5)).animated, false);
  assert.equal(sniff(isobmff(['avis', 'avif'], 8, 8)).animated, true);
  assert.equal(sniff(FIXTURES.avif).animated, false);
  assert.equal(sniff(FIXTURES.jpeg).animated, false);
  assert.equal(sniff(FIXTURES.svg).animated, null, 'SVG: unknown');
  assert.equal(sniff(Buffer.from('text')).animated, null);
  // Undecided when the bytes end first.
  assert.equal(sniff(gif(2, 2, 3).subarray(0, 40)).animated, null);
  assert.equal(sniff(png(2, 2).subarray(0, 33)).animated, null);
  // A GIF whose second frame lies past the sniff window is still seen when the bytes are there.
  const big = gif(2, 2, 2);
  const padded = bytes(big.subarray(0, 13 + 6 + 19), [0x21, 0xfe], ...Array(400).fill(bytes([255], Buffer.alloc(255))), [0], big.subarray(13 + 6 + 19));
  assert.ok(padded.length > POLICY.sniffBytes);
  assert.equal(sniff(padded).animated, true);
  assert.equal(sniff(padded.subarray(0, POLICY.sniffBytes)).animated, null);
});

test('sniff SVG: BOM, XML declaration, comments, processing instructions, doctype, whitespace', () => {
  const ok = {
    plain: svg(''),
    'leading whitespace': svg('\n\n   \t'),
    bom: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), svg('<?xml version="1.0" encoding="UTF-8"?>')]),
    comment: svg('<!-- Generator: Adobe Illustrator -->\n'),
    'stylesheet PI': svg('<?xml version="1.0"?><?xml-stylesheet href="a.css"?>\n'),
    doctype: svg('<?xml version="1.0"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n'),
    'doctype with a subset': svg('<!DOCTYPE svg [ <!ENTITY ns "http://www.w3.org/2000/svg"> ]>'),
    'self-closing root': Buffer.from('<svg/>'),
    'root then newline': Buffer.from('<svg\n  width="1" height="1"></svg>'),
  };
  for (const [what, b] of Object.entries(ok)) assert.equal(sniff(b).format, 'svg', what);
  const not = {
    html: Buffer.from('<!DOCTYPE html><html><body><svg width="1" height="1"></svg></body></html>'),
    'html doctype': Buffer.from('<!DOCTYPE html>\n<svg></svg>'),
    'text first': Buffer.from('hello <svg></svg>'),
    'svgfoo element': Buffer.from('<svgfoo></svgfoo>'),
    'unclosed comment': Buffer.from('<!-- <svg></svg>'),
    'unclosed declaration': Buffer.from('<?xml version="1.0" <svg></svg>'),
    'root after 4 KiB': svg(`<!--${'x'.repeat(5000)}-->`),
    'utf-16': Buffer.from('﻿<svg></svg>', 'utf16le'),
  };
  for (const [what, b] of Object.entries(not)) assert.equal(sniff(b).format, null, what);
  assert.equal(sniff(svg(`<!--${'x'.repeat(3900)}-->`)).format, 'svg', 'just within 4 KiB');
});

// ---------------------------------------------------------------- dimensions

test('dimensions: from each format\'s header', () => {
  assert.deepEqual(dimensions(FIXTURES.png, 'png'), { width: 4, height: 3 });
  assert.deepEqual(dimensions(png(70000, 1), 'png'), { width: 70000, height: 1 });
  assert.deepEqual(dimensions(jpeg(640, 480), 'jpeg'), { width: 640, height: 480 });
  assert.deepEqual(dimensions(jpeg(4000, 3000, { exif: true }), 'jpeg'), { width: 4000, height: 3000 }, 'APP1 / EXIF before SOF0');
  assert.deepEqual(dimensions(jpeg(33, 44, { sof: 0xc2 }), 'jpeg'), { width: 33, height: 44 }, 'progressive');
  assert.deepEqual(dimensions(gif(5, 6), 'gif'), { width: 5, height: 6 });
  assert.deepEqual(dimensions(webpVp8(300, 200), 'webp'), { width: 300, height: 200 });
  assert.deepEqual(dimensions(webpVp8l(300, 200), 'webp'), { width: 300, height: 200 });
  assert.deepEqual(dimensions(webpVp8l(16384, 1), 'webp'), { width: 16384, height: 1 });
  assert.deepEqual(dimensions(webpVp8x(16777216, 2), 'webp'), { width: 16777216, height: 2 });
  assert.deepEqual(dimensions(bmp(7, 9), 'bmp'), { width: 7, height: 9 });
  assert.deepEqual(dimensions(bmp(7, -9), 'bmp'), { width: 7, height: 9 }, 'top-down: negative height');
  assert.deepEqual(dimensions(bmp(5, 6, 12), 'bmp'), { width: 5, height: 6 });
  assert.equal(dimensions(bmp(-7, 9), 'bmp'), null);
  assert.deepEqual(dimensions(ico([[16, 16], [0, 0], [48, 48]]), 'ico'), { width: 256, height: 256, count: 3 }, '0 = 256');
  assert.deepEqual(dimensions(ico([[32, 32]], 2), 'ico'), { width: 32, height: 32, count: 1 });
  assert.deepEqual(dimensions(FIXTURES.avif, 'avif'), { width: 64, height: 32 });
  assert.deepEqual(dimensions(FIXTURES.heic, 'heic'), { width: 4032, height: 3024 });
  const grid = bytes(ftyp('avif'), fullBox('meta', box('iprp', box('ipco', ispe(512, 512), ispe(1024, 768), ispe(512, 256)))));
  assert.deepEqual(dimensions(grid, 'avif'), { width: 1024, height: 768 }, 'the largest extent (a grid\'s canvas)');
  assert.deepEqual(dimensions(psd(800, 600), 'psd'), { width: 800, height: 600 });
  assert.equal(dimensions(FIXTURES.tiff, 'tiff'), null, 'an IFD without entries');
  assert.deepEqual(dimensions(tiff(640, 480), 'tiff'), { width: 640, height: 480 }, 'II, SHORT values');
  assert.deepEqual(dimensions(tiff(70000, 3, { be: true }), 'tiff'), { width: 70000, height: 3 }, 'MM, a LONG width');
  assert.deepEqual(dimensions(tiff(9, 8, { big: true }), 'tiff'), { width: 9, height: 8 }, 'BigTIFF, LONG8 values');
  assert.deepEqual(dimensions(tiff(9, 8, { big: true, be: true }), 'tiff'), { width: 9, height: 8 }, 'BigTIFF MM');
  assert.equal(dimensions(tiff(9, 8, { at: 5000 }), 'tiff'), null, 'the IFD past the bytes (a head read)');
  assert.equal(dimensions(FIXTURES.jxl, 'jxl'), null);
  assert.equal(dimensions(FIXTURES.png, null), null);
  assert.equal(dimensions(FIXTURES.png, 'nope'), null);
});

test('dimensions: HEIF / AVIF and TIFF turned by their headers give the displayed size (irot; Orientation 5-8)', () => {
  const heic = (o) => dimensions(heif(['heic', 'mif1'], 4032, 3024, o), 'heic');
  assert.deepEqual(heic(), { width: 4032, height: 3024 }, 'the primary item (pitm / ipma), not a larger tile');
  assert.deepEqual(heic({ angle: 1 }), { width: 3024, height: 4032 }, 'irot 90°: an iPhone\'s portrait photo, stored landscape');
  assert.deepEqual(heic({ angle: 3 }), { width: 3024, height: 4032 }, 'irot 270°');
  assert.deepEqual(heic({ angle: 2 }), { width: 4032, height: 3024 }, 'irot 180°');
  assert.deepEqual(dimensions(heif(['avif', 'mif1'], 64, 32, { angle: 1 }), 'avif'), { width: 32, height: 64 });
  const item = (...props) => bytes(ftyp('heic', 'mif1'), fullBox('meta', ...props));
  assert.deepEqual(dimensions(item(pitm(1), box('iprp', box('ipco', ispe(40, 30), irot(1)), ipma([[1, [1]], [2, [2]]]))), 'heic'), { width: 40, height: 30 }, 'another item\'s irot');
  assert.deepEqual(dimensions(item(box('iprp', box('ipco', ispe(40, 30), ispe(4, 3), irot(3)))), 'heic'), { width: 30, height: 40 }, 'no pitm / ipma: the largest extent, any irot');
  // pitm and ipma version 1 (32-bit item ids), ipma flag 1 (15-bit property indices).
  const wide = item(box('pitm', [1, 0, 0, 0], u32be(70000)), box('iprp', box('ipco', irot(1), ispe(40, 30)),
    box('ipma', [1, 0, 0, 1], u32be(1), u32be(70000), [2], u16be(0x8000 | 2), u16be(1))));
  assert.deepEqual(dimensions(wide, 'heic'), { width: 30, height: 40 });
  // The primary's properties cut off (a head read): unknown, not maybe unturned.
  const turned = heif(['heic', 'mif1'], 40, 30, { angle: 1 });
  assert.equal(dimensions(turned.subarray(0, turned.indexOf('ipma') + 6), 'heic'), null);

  for (const o of [1, 2, 3, 4]) assert.deepEqual(dimensions(tiff(96, 64, { orientation: o }), 'tiff'), { width: 96, height: 64 }, `Orientation ${o}`);
  for (const o of [5, 6, 7, 8]) assert.deepEqual(dimensions(tiff(96, 64, { orientation: o }), 'tiff'), { width: 64, height: 96 }, `Orientation ${o}`);
  assert.deepEqual(dimensions(tiff(96, 64, { orientation: 6, be: true }), 'tiff'), { width: 64, height: 96 }, 'MM');
  assert.deepEqual(dimensions(tiff(96, 64, { orientation: 8, big: true }), 'tiff'), { width: 64, height: 96 }, 'BigTIFF');
  const t = tiff(96, 64, { orientation: 6 });
  assert.equal(dimensions(t.subarray(0, t.length - 10), 'tiff'), null, 'cut before the Orientation: unknown');
});

test('dimensions SVG: width / height, viewBox, units, none', () => {
  const d = (root) => dimensions(Buffer.from(`${root}</svg>`), 'svg');
  assert.deepEqual(d('<svg width="10" height="20">'), { width: 10, height: 20 });
  assert.deepEqual(d('<svg width="10.4px" height=\'20.6\' >'), { width: 10, height: 21 });
  assert.deepEqual(d('<svg viewBox="0 0 24 12">'), { width: 24, height: 12 });
  assert.deepEqual(d('<svg viewBox="0,0,24,12" width="48">'), { width: 48, height: 24 }, 'aspect from the viewBox');
  assert.deepEqual(d('<svg viewBox="0 0 24 12" height="6">'), { width: 12, height: 6 });
  assert.deepEqual(d('<svg width="100%" height="100%" viewBox="0 0 30 40">'), { width: 30, height: 40 }, 'percentages: the viewBox');
  assert.deepEqual(d('<svg stroke-width="5" width="7" line-height="9" height="8">'), { width: 7, height: 8 }, 'not a suffix of another attribute');
  assert.equal(d('<svg width="2em" height="3em">'), null);
  assert.equal(d('<svg>'), null);
  assert.equal(d('<svg viewBox="0 0 -1 5">'), null);
  assert.equal(d('<svg viewBox="a b c d">'), null);
  assert.equal(dimensions(Buffer.from('<svg width="10" height="20"'), 'svg'), null, 'an unclosed tag');
  assert.deepEqual(dimensions(FIXTURES.svg, 'svg'), { width: 10, height: 20 }, 'after an XML declaration');
});

// ---------------------------------------------------------------- hostile bytes

test('hostile input: every truncation of every fixture - never a throw, never a wrong answer', () => {
  const all = { ...FIXTURES, apng: png(3, 3, { apng: true }), vp8: webpVp8(9, 9), vp8l: webpVp8l(9, 9), gifs: gif(3, 3, 3), bmp12: bmp(3, 3, 12),
    tiffs: tiff(640, 480), tiffmm: tiff(70000, 3, { be: true }), bigtiff: tiff(9, 8, { big: true, be: true }),
    tifft: tiff(96, 64, { orientation: 6 }), heift: heif(['heic', 'mif1'], 40, 30, { angle: 1 }),
  };
  for (const [name, b] of Object.entries(all)) {
    const id = sniff(b).format;
    const full = dimensions(b, id);
    for (let n = 0; n <= Math.min(b.length, 300); n++) {
      const cut = b.subarray(0, n);
      const m = sniff(cut, { path: `x.${name}` });
      assert.ok(m.format === null || m.format === id, `${name}[0..${n}]: ${m.format}`);
      const got = dimensions(cut, id);
      assert.ok(got === null || JSON.stringify(got) === JSON.stringify(full), `${name}[0..${n}]: ${JSON.stringify(got)}`);
      if (n <= 64 && id !== 'svg' && id !== 'jpeg' && id !== 'ico') {
        // Headers longer than the cut can't be read; the short ones (GIF, WebP, BMP) may be.
        assert.ok(got === null || n >= 10, `${name}[0..${n}]`);
      }
    }
  }
});

test('hostile input: random bytes behind every magic number never throw', () => {
  let seed = 42;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
  const prefixes = Object.values(FIXTURES).map((b) => b.subarray(0, 16));
  for (let i = 0; i < 3000; i++) {
    const p = prefixes[i % prefixes.length];
    const tail = Buffer.alloc(rand() % 200);
    for (let k = 0; k < tail.length; k++) tail[k] = rand() & 0xff;
    const b = bytes(p.subarray(0, rand() % (p.length + 1)), tail);
    const m = sniff(b);
    for (const id of Object.keys(FORMATS)) dimensions(b, id);
    if (m.format) dimensions(b, m.format);
    parseLfsPointer(b);
  }
});

test('hostile input: a JPEG marker loop, a zero-length segment, a GIF with a broken block', () => {
  const loop = bytes([0xff, 0xd8], ...Array(20000).fill(Buffer.from([0xff, 0xe0, 0, 2])));
  assert.equal(dimensions(loop, 'jpeg'), null);
  assert.equal(dimensions(bytes([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0xff, 0xc0]), 'jpeg'), null, 'length < 2');
  assert.equal(dimensions(bytes([0xff, 0xd8, 0xff, 0xda, 0, 4, 0, 0]), 'jpeg'), null, 'scan before a frame header');
  assert.equal(dimensions(bytes([0xff, 0xd8, 0x00, 0x00]), 'jpeg'), null, 'not a marker');
  assert.equal(dimensions(bytes([0xff, 0xd8], Buffer.alloc(100, 0xff)), 'jpeg'), null, 'only fill bytes');
  assert.equal(dimensions(jpeg(0, 10), 'jpeg'), null, 'width 0');
  const g = gif(2, 2, 2);
  const broken = Buffer.from(g);
  broken[13 + 6] = 0x99; // where the NETSCAPE extension starts
  assert.equal(sniff(broken).animated, null);
  assert.equal(sniff(bytes(g.subarray(0, 10), [0xf7, 0, 0])).animated, null, 'a color table past the end');
});

test('hostile input: crafted files stay bounded - an AVIF ftyp box claiming the whole file, a PNG of countless chunks', () => {
  // The ftyp box says 4 GB; its 'avis' brand sits past the sniffed head, which is all that is read.
  const avif = bytes(u32be(0xffffffff), 'ftyp', 'avif', u32be(0), Buffer.alloc(POLICY.sniffBytes, 0x20), 'avis', Buffer.alloc(8 * 1024 * 1024, 0x20));
  assert.deepEqual([sniff(avif).format, sniff(avif).animated], ['avif', false]);
  // acTL after thousands of empty chunks: found within the chunk cap, unknown past it.
  const apng = (n) => bytes(png(1, 1).subarray(0, 33), ...Array(n).fill(pngChunk('tEXt', [])), pngChunk('acTL', bytes(u32be(2), u32be(0))), pngChunk('IEND', []));
  assert.equal(sniff(apng(9000)).animated, true);
  assert.equal(sniff(apng(10000)).animated, null);
});

test('hostile input: ISO-BMFF boxes of size 0, 1 and beyond the buffer', () => {
  const head = ftyp('avif', 'mif1');
  const body = fullBox('meta', box('iprp', box('ipco', ispe(10, 20))));
  // size 0: the box runs to the end.
  const zero = bytes(head, u32be(0), 'meta', [0, 0, 0, 0], box('iprp', box('ipco', ispe(10, 20))));
  assert.deepEqual(dimensions(zero, 'avif'), { width: 10, height: 20 });
  // size 1: a 64-bit size follows.
  const inner = bytes([0, 0, 0, 0], box('iprp', box('ipco', ispe(11, 21))));
  const large = bytes(head, u32be(1), 'meta', u32be(0), u32be(16 + inner.length), inner);
  assert.deepEqual(dimensions(large, 'avif'), { width: 11, height: 21 });
  // A 64-bit size far past the buffer, and a box claiming more than the buffer: cut there.
  const huge = bytes(head, u32be(1), 'meta', u32be(0xffffffff), u32be(0xffffffff), inner);
  assert.deepEqual(dimensions(huge, 'avif'), { width: 11, height: 21 });
  const over = Buffer.from(bytes(head, body));
  over.writeUInt32BE(1e9, head.length);
  assert.deepEqual(dimensions(over, 'avif'), { width: 10, height: 20 });
  // A size smaller than its header, a truncated 64-bit size, an ispe too short: null.
  assert.equal(dimensions(bytes(head, u32be(4), 'meta', body), 'avif'), null);
  assert.equal(dimensions(bytes(head, u32be(1), 'meta', [0, 0]), 'avif'), null);
  assert.equal(dimensions(bytes(head, fullBox('meta', box('iprp', box('ipco', box('ispe', [0, 0, 0, 0], u32be(5)))))), 'avif'), null);
  // Nesting deeper than 4 is not followed.
  const deep = bytes(head, fullBox('meta', box('iprp', box('ipco', box('ipco', box('ipco', ispe(3, 3)))))));
  assert.equal(dimensions(deep, 'avif'), null);
  // A thousand empty boxes: bounded.
  assert.equal(dimensions(bytes(head, ...Array(5000).fill(box('free'))), 'avif'), null);
});

// ---------------------------------------------------------------- Git LFS pointers

const OID = 'a'.repeat(32) + '0123456789abcdef'.repeat(2);
const pointer = (text) => Buffer.from(text, 'utf8');

test('parseLfsPointer: valid pointers, extra keys', () => {
  const v1 = 'version https://git-lfs.github.com/spec/v1\n';
  assert.deepEqual(parseLfsPointer(pointer(`${v1}oid sha256:${OID}\nsize 2457600\n`)), { oid: OID, size: 2457600 });
  assert.deepEqual(parseLfsPointer(pointer(`${v1}ext-0-foo sha256:${'b'.repeat(64)}\noid sha256:${OID}\nsize 12\nx-custom yes\n`)), { oid: OID, size: 12 });
  assert.deepEqual(parseLfsPointer(pointer(`${v1}oid sha256:${OID}\nsize 0`)), { oid: OID, size: 0 }, 'no final newline');
});

test('parseLfsPointer: refusals', () => {
  const v1 = 'version https://git-lfs.github.com/spec/v1\n';
  const bad = {
    'missing oid': `${v1}size 12\n`,
    'missing size': `${v1}oid sha256:${OID}\n`,
    'non-hex oid': `${v1}oid sha256:${'g'.repeat(64)}\nsize 12\n`,
    'short oid': `${v1}oid sha256:${'a'.repeat(63)}\nsize 12\n`,
    'upper-case oid': `${v1}oid sha256:${'A'.repeat(64)}\nsize 12\n`,
    'other hash': `${v1}oid sha1:${'a'.repeat(40)}\nsize 12\n`,
    'size not a number': `${v1}oid sha256:${OID}\nsize twelve\n`,
    'negative size': `${v1}oid sha256:${OID}\nsize -1\n`,
    'size too big': `${v1}oid sha256:${OID}\nsize 12345678901234567\n`,
    'two oids': `${v1}oid sha256:${OID}\noid sha256:${OID}\nsize 1\n`,
    'other version': `version https://hawser.github.com/spec/v1\noid sha256:${OID}\nsize 12\n`,
    'not first line': `oid sha256:${OID}\n${v1}size 12\n`,
    'CRLF': `${v1.replace('\n', '\r\n')}oid sha256:${OID}\r\nsize 12\r\n`,
    'a malformed line': `${v1}oid sha256:${OID}\nsize 12\n\nnope\n`,
    'over 1024 bytes': `${v1}oid sha256:${OID}\nsize 12\nx ${'y'.repeat(1024)}\n`,
    empty: '',
  };
  for (const [what, text] of Object.entries(bad)) assert.equal(parseLfsPointer(pointer(text)), null, what);
  assert.equal(parseLfsPointer(bytes(`${v1}oid sha256:${OID}\nsize 12\n`, [0])), null, 'a NUL');
  assert.equal(parseLfsPointer(Buffer.from(`${v1}oid sha256:${OID}\nsize 12\nnote café\n`, 'utf8')), null, 'non-ASCII');
  assert.equal(parseLfsPointer(null), null);
});

test('the demo repository\'s image files (test/fixtures/images, made by real encoders) sniff as their names say', () => {
  const dir = path.join(__dirname, 'fixtures', 'images');
  const want = {
    'logo-v1.png': ['png', false, '64×64'], 'logo-v2.png': ['png', false, '64×64'],
    'hero-v1.webp': ['webp', true, '96×64'], 'hero-v2.webp': ['webp', true, '96×64'],
    'sprite.gif': ['gif', true, '96×64'], 'photo.jpg': ['jpeg', false, '80×40'], // stored 80×40, EXIF orientation 6
    'badge.avif': ['avif', false, '64×64'], 'scan.heic': ['heic', false, '64×64'],
    'scan.tiff': ['tiff', false, '96×64'], 'layers.psd': ['psd', false, '64×64'], // two pages; layers
    'portrait.heic': ['heic', false, '64×96'], 'portrait.tiff': ['tiff', false, '64×96'], // stored 96×64, turned (irot 1, Orientation 6)
    'icon-v1.svg': ['svg', null, '48×48'], 'icon-v2.svg': ['svg', null, '48×48'],
    'mislabeled.png': ['jpeg', false, '48×48'],
  };
  assert.deepEqual(fs.readdirSync(dir).sort(), Object.keys(want).sort());
  for (const [file, [format, animated, size]] of Object.entries(want)) {
    const b = fs.readFileSync(path.join(dir, file));
    const m = sniff(b, { path: file });
    const d = dimensions(b, m.format);
    assert.deepEqual([m.format, m.animated, d && `${d.width}×${d.height}`, m.mismatch], [format, animated, size, file === 'mislabeled.png'], file);
  }
});
