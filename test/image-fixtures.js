'use strict';
// Image bytes for the image preview tests (test/image-format.test.js, test/image-preview.test.js),
// built byte by byte: the smallest valid header of each format, so no binary fixture files are needed.
const zlib = require('node:zlib');

const bytes = (...parts) => Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))));
const u16le = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u16be = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u24le = (n) => Buffer.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff]);
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u32be = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const i32le = (n) => { const b = Buffer.alloc(4); b.writeInt32LE(n); return b; };

function pngChunk(type, data) {
  const td = bytes(type, data);
  return bytes(u32be(data.length), td, u32be(zlib.crc32(td)));
}

/** A real, decodable RGBA PNG (`apng`: with an acTL chunk before IDAT). */
function png(w, h, { apng = false } = {}) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  return bytes(
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    pngChunk('IHDR', bytes(u32be(w), u32be(h), [8, 6, 0, 0, 0])),
    apng ? pngChunk('acTL', bytes(u32be(2), u32be(0))) : [],
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', []),
  );
}

function jpeg(w, h, { exif = false, sof = 0xc0 } = {}) {
  const seg = (m, data) => bytes([0xff, m], u16be(data.length + 2), data);
  return bytes(
    [0xff, 0xd8],
    seg(0xe0, bytes('JFIF\0', [1, 1, 0], u16be(1), u16be(1), [0, 0])),
    exif ? seg(0xe1, bytes('Exif\0\0', 'MM\0*', u32be(8), Buffer.alloc(300, 0xff))) : [],
    seg(0xdb, Buffer.alloc(65)),
    [0xff, 0xff], // fill bytes before a marker
    seg(sof, bytes([8], u16be(h), u16be(w), [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1])),
    seg(0xda, bytes([3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0])),
    [0x12, 0x34, 0xff, 0xd9],
  );
}

function gif(w, h, frames = 1) {
  const frame = bytes(
    [0x21, 0xf9, 4, 0, 10, 0, 0, 0], // graphic control extension
    [0x2c], u16le(0), u16le(0), u16le(w), u16le(h), [0], // image descriptor, no local table
    [2, 2, 0x4c, 0x01, 0], // LZW minimum code size, one sub-block, terminator
  );
  return bytes('GIF89a', u16le(w), u16le(h), [0x80, 0, 0], [0, 0, 0, 255, 255, 255],
    [0x21, 0xff, 11], 'NETSCAPE2.0', [3, 1, 0, 0, 0], ...Array(frames).fill(frame), [0x3b]);
}

const riff = (chunk, data) => bytes('RIFF', u32le(4 + 8 + data.length), 'WEBP', chunk, u32le(data.length), data);
const webpVp8 = (w, h) => riff('VP8 ', bytes([0x50, 0x01, 0x00], [0x9d, 0x01, 0x2a], u16le(w), u16le(h), Buffer.alloc(8)));
function webpVp8l(w, h) {
  const bits = (w - 1) | ((h - 1) << 14); // 14 bits each, then alpha and version bits (0)
  return riff('VP8L', bytes([0x2f], u32le(bits >>> 0), Buffer.alloc(6)));
}
const webpVp8x = (w, h, { animated = false } = {}) => riff('VP8X', bytes([animated ? 0x12 : 0x10, 0, 0, 0], u24le(w - 1), u24le(h - 1)));

const box = (type, ...data) => { const d = bytes(...data); return bytes(u32be(8 + d.length), type, d); };
const fullBox = (type, ...data) => box(type, [0, 0, 0, 0], ...data);
const ftyp = (major, ...compat) => box('ftyp', major, u32be(0), ...compat);
const ispe = (w, h) => fullBox('ispe', u32be(w), u32be(h));
const isobmff = (brands, w, h) => bytes(ftyp(...brands), fullBox('meta', box('iprp', box('ipco', ispe(w, h)))), box('mdat', Buffer.alloc(16)));

function bmp(w, h, dib = 40) {
  const header = dib === 12 ? bytes(u32le(12), u16le(w), u16le(h), u16le(1), u16le(24))
    : bytes(u32le(dib), i32le(w), i32le(h), u16le(1), u16le(24), Buffer.alloc(dib - 16));
  return bytes('BM', u32le(14 + header.length + 4), u32le(0), u32le(14 + header.length), header, Buffer.alloc(4));
}

function ico(entries, type = 1) {
  const dir = bytes([0, 0], u16le(type), u16le(entries.length));
  let offset = 6 + 16 * entries.length;
  const list = entries.map(([w, h]) => { const e = bytes([w, h, 0, 0], u16le(1), u16le(32), u32le(40), u32le(offset)); offset += 40; return e; });
  return bytes(dir, ...list, Buffer.alloc(40 * entries.length));
}

const psd = (w, h, version = 1) => bytes('8BPS', u16be(version), Buffer.alloc(6), u16be(3), u32be(h), u32be(w), u16be(8), u16be(3));
/**
 * A TIFF header and its first IFD: ImageWidth, ImageLength (SHORT, or LONG over 65535; BigTIFF:
 * LONG8) and Compression. `be`: big-endian (MM); `big`: BigTIFF; `at`: the IFD offset written
 * instead (no IFD follows: a head read).
 */
function tiff(w, h, { be = false, big = false, at = null } = {}) {
  const n = (v, size) => {
    const b = Buffer.alloc(size);
    if (size === 8) b.writeBigUInt64LE(BigInt(v));
    else if (size === 4) b.writeUInt32LE(v);
    else b.writeUInt16LE(v);
    return be ? b.reverse() : b;
  };
  const value = (v, size) => Buffer.concat([n(v, size), Buffer.alloc((big ? 8 : 4) - size)]); // left-justified
  const entry = (tag, v) => {
    const [type, size] = big ? [16, 8] : v > 0xffff ? [4, 4] : [3, 2];
    return bytes(n(tag, 2), n(type, 2), n(1, big ? 8 : 4), value(v, size));
  };
  const entries = [entry(256, w), entry(257, h), entry(259, 1)];
  const head = big ? bytes(be ? 'MM' : 'II', n(43, 2), n(8, 2), n(0, 2), n(at ?? 16, 8)) : bytes(be ? 'MM' : 'II', n(42, 2), n(at ?? 8, 4));
  if (at !== null) return head;
  return bytes(head, n(entries.length, big ? 8 : 2), ...entries, n(0, big ? 8 : 4));
}

const svg = (head, root = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="20">') => Buffer.from(`${head}${root}<rect/></svg>\n`, 'utf8');

module.exports = {
  bytes, u16le, u16be, u24le, u32le, u32be, i32le, pngChunk, png, jpeg, gif, riff, webpVp8, webpVp8l, webpVp8x, box, fullBox, ftyp, ispe, isobmff, bmp, ico, psd, tiff, svg,
};
