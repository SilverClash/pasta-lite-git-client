/*
 * Pasta Lite - image formats for the diff view's image preview (docs/plans/image-preview.md §3):
 * the catalogue, content sniffing, header dimensions, Git LFS pointers and the preview limits.
 *
 * Pure, dependency-free. Works in Node (`require('./src/image-format.js')`) and in the browser as
 * a plain <script> (exposes `window.PLImageFormat`), like src/error-kinds.js. Main sniffs the bytes
 * (src/image-preview.js); the renderer only needs the catalogue (labels, tiers).
 *
 * Content decides the format, the file name is only a hint: a `.png` holding JPEG bytes is JPEG
 * (with `mismatch`), a `.webp` holding text is no format at all. Every parser reads untrusted
 * bytes (a Uint8Array or a Buffer): it is bounds-checked, returns null on short or odd input and
 * never throws.
 *
 * FORMATS: {id: {id, label, mime, tier, extensions, animatable}} (frozen). tier 1: Chromium
 *   decodes it in an <img>; 2: recognised, no decoder in the app (HEIC, TIFF, PSD: the OS
 *   thumbnailer of I4; .svgz: not supported); 'probe': Chromium may decode it, unknown until the
 *   renderer tries (JPEG XL, off by default). `mime` is what a Blob of tier 1 bytes gets, null
 *   for tiers 2 and 'probe' (nothing hands them to Chromium).
 * POLICY: the preview limits (frozen; plan §5.3). Sizes in bytes, per side.
 * sniff(bytes, {path}) -> {format, byContent, extensionHint, mismatch, animated}: `format` an id
 *   from the first POLICY.sniffBytes bytes, or null; `extensionHint` the id the file name's
 *   extension suggests (or null); `mismatch` both are set and differ; `animated` true / false,
 *   or null when unknown (the bytes end before it is decided, or an SVG).
 * dimensions(bytes, format) -> {width, height} | null from the header only (ICO / CUR add
 *   `count`, the number of entries; null for TIFF and JPEG XL).
 * parseLfsPointer(bytes) -> {oid, size} | null: a Git LFS pointer file (spec v1).
 * extensionOf(path), formatOfPath(path): the lower-cased extension of the base name / its format id.
 */
(function (exports) {
  'use strict';

  const fmt = (id, label, mime, tier, extensions, animatable = false) => Object.freeze({
    id, label, mime, tier, extensions: Object.freeze(extensions), animatable,
  });

  const FORMATS = Object.freeze({
    png: fmt('png', 'PNG', 'image/png', 1, ['png', 'apng'], true),
    jpeg: fmt('jpeg', 'JPEG', 'image/jpeg', 1, ['jpg', 'jpeg', 'jpe', 'jfif', 'pjpeg', 'pjp']),
    gif: fmt('gif', 'GIF', 'image/gif', 1, ['gif'], true),
    webp: fmt('webp', 'WebP', 'image/webp', 1, ['webp'], true),
    avif: fmt('avif', 'AVIF', 'image/avif', 1, ['avif'], true),
    bmp: fmt('bmp', 'BMP', 'image/bmp', 1, ['bmp', 'dib']),
    ico: fmt('ico', 'ICO', 'image/x-icon', 1, ['ico', 'cur']),
    svg: fmt('svg', 'SVG', 'image/svg+xml', 1, ['svg']),
    heic: fmt('heic', 'HEIC', null, 2, ['heic', 'heif', 'hif']),
    tiff: fmt('tiff', 'TIFF', null, 2, ['tif', 'tiff']),
    psd: fmt('psd', 'PSD', null, 2, ['psd', 'psb']),
    svgz: fmt('svgz', 'SVGZ', null, 2, ['svgz']),
    jxl: fmt('jxl', 'JPEG XL', null, 'probe', ['jxl']),
  });

  const BY_EXTENSION = new Map();
  for (const f of Object.values(FORMATS)) for (const e of f.extensions) BY_EXTENSION.set(e, f.id);

  const POLICY = Object.freeze({
    sniffBytes: 64 * 1024, // what sniff() looks at; a worktree side over the soft cap reads only this
    softMaxBytes: 20 * 1024 * 1024, // over it: 'too-large' {soft: true}; force loads it
    maxBytes: 50 * 1024 * 1024, // never read (= DIFF_VIEW_MAX_RAW, src/diff-view.js)
    svgMaxBytes: 5 * 1024 * 1024, // SVG is parsed as XML by the page's renderer process
    maxPixels: 100000000, // header dimensions; over it: 'too-large' {limit: 'pixels'}
    lfsPointerMax: 1024,
  });

  // An SVG's root element must start within this many bytes (after a BOM, XML declaration,
  // comments, processing instructions and an SVG doctype).
  const SVG_SNIFF_BYTES = 4096;

  // ---------------------------------------------------------------- bytes

  const EMPTY = new Uint8Array(0);

  /** A Uint8Array view of `b` (a Uint8Array, Buffer, other typed array or ArrayBuffer), else empty. */
  function view(b) {
    if (b instanceof Uint8Array) return b;
    if (ArrayBuffer.isView(b)) return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    if (b instanceof ArrayBuffer) return new Uint8Array(b);
    return EMPTY;
  }

  /** `b` has `n` bytes from `off` (n = 0: `b` is at least `off` long). */
  const has = (b, off, n) => off >= 0 && n >= 0 && off + n <= b.length;
  const u16le = (b, i) => b[i] | (b[i + 1] << 8);
  const u16be = (b, i) => (b[i] << 8) | b[i + 1];
  const u24le = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
  const u32le = (b, i) => u24le(b, i) + b[i + 3] * 0x1000000;
  const u32be = (b, i) => b[i] * 0x1000000 + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);
  const i32le = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24);
  const ascii = (b, off, n) => (has(b, off, n) ? String.fromCharCode(...b.subarray(off, off + n)) : null);
  const startsWith = (b, bytes, off = 0) => has(b, off, bytes.length) && bytes.every((v, i) => b[off + i] === v);

  const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const JXL_BOX = [0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a];
  const BMP_DIB_SIZES = new Set([12, 40, 52, 56, 108, 124]);
  const AVIF_BRANDS = new Set(['avif', 'avis']);
  const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs']);

  // ---------------------------------------------------------------- file names

  /** Lower-cased extension of the base name of `p` ('a/B.PNG' -> 'png'), or null ('.png', 'x', 'x.'). */
  function extensionOf(p) {
    if (typeof p !== 'string') return null;
    const base = p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1);
    const dot = base.lastIndexOf('.');
    return dot > 0 && dot < base.length - 1 ? base.slice(dot + 1).toLowerCase() : null;
  }

  /** The format id `p`'s extension suggests, or null. */
  const formatOfPath = (p) => BY_EXTENSION.get(extensionOf(p)) || null;

  // ---------------------------------------------------------------- sniffing

  /** The ISO-BMFF `ftyp` brands (major first), or null when `b` doesn't start with an ftyp box. */
  function ftypBrands(b) {
    if (!has(b, 0, 16) || ascii(b, 4, 4) !== 'ftyp') return null;
    const size = u32be(b, 0);
    if (size < 16) return null;
    const brands = [ascii(b, 8, 4)];
    for (let i = 16; i + 4 <= Math.min(size, b.length); i += 4) brands.push(ascii(b, i, 4));
    return brands;
  }

  /** 'avif' / 'heic' from the ftyp brands: the major brand decides first, then the compatible ones. */
  function isobmffFormat(brands) {
    const of = (brand) => (AVIF_BRANDS.has(brand) && 'avif') || (HEIC_BRANDS.has(brand) && 'heic') || null;
    const major = of(brands[0]);
    if (major) return major;
    if (brands.some((x) => AVIF_BRANDS.has(x))) return 'avif';
    if (brands.some((x) => HEIC_BRANDS.has(x))) return 'heic';
    return null;
  }

  function isIco(b) {
    if (!(startsWith(b, [0, 0, 1, 0]) || startsWith(b, [0, 0, 2, 0])) || !has(b, 6, 16)) return false;
    const count = u16le(b, 4);
    // The first entry: reserved byte 0, some image data, stored after the directory.
    return count >= 1 && b[9] === 0 && u32le(b, 14) > 0 && u32le(b, 18) >= 6 + 16 * count;
  }

  const isWs = (c) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;

  /**
   * Offset of the `<svg` root element in `b` when the text before it is only a UTF-8 BOM,
   * whitespace, an XML declaration or other processing instructions, comments and an SVG
   * doctype, and it starts within SVG_SNIFF_BYTES; else -1.
   */
  function svgStart(b) {
    const s = String.fromCharCode(...b.subarray(0, Math.min(b.length, SVG_SNIFF_BYTES)));
    let i = s.startsWith('\xef\xbb\xbf') ? 3 : 0;
    for (;;) {
      while (i < s.length && isWs(s.charCodeAt(i))) i++;
      if (s.startsWith('<?', i)) {
        const end = s.indexOf('?>', i + 2);
        if (end < 0) return -1;
        i = end + 2;
      } else if (s.startsWith('<!--', i)) {
        const end = s.indexOf('-->', i + 4);
        if (end < 0) return -1;
        i = end + 3;
      } else if (/^<!DOCTYPE\s+svg[\s>[]/i.test(s.slice(i, i + 15))) {
        const open = s.indexOf('[', i);
        const close = s.indexOf('>', i);
        if (close < 0) return -1;
        if (open >= 0 && open < close) { // an internal subset: [ ... ]>
          const sub = s.indexOf(']', open);
          if (sub < 0) return -1;
          const end = s.indexOf('>', sub);
          if (end < 0) return -1;
          i = end + 1;
        } else {
          i = close + 1;
        }
      } else {
        return /^<svg[\s/>]/.test(s.slice(i, i + 5)) ? i : -1;
      }
    }
  }

  /** The format id of the bytes alone, or null. `ext`: the extension's hint (only .svgz needs it). */
  function contentFormat(b, ext) {
    if (startsWith(b, PNG_SIG)) return 'png';
    if (startsWith(b, [0xff, 0xd8, 0xff])) return 'jpeg';
    const head6 = ascii(b, 0, 6);
    if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'gif';
    if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp';
    if (startsWith(b, JXL_BOX) || startsWith(b, [0xff, 0x0a])) return 'jxl';
    const brands = ftypBrands(b);
    if (brands) return isobmffFormat(brands);
    if (ascii(b, 0, 2) === 'BM' && has(b, 14, 4) && BMP_DIB_SIZES.has(u32le(b, 14))) return 'bmp';
    if (isIco(b)) return 'ico';
    const head4 = ascii(b, 0, 4);
    if (head4 === 'II*\0' || head4 === 'MM\0*' || head4 === 'II+\0' || head4 === 'MM\0+') return 'tiff';
    if (head4 === '8BPS' && has(b, 4, 2) && (u16be(b, 4) === 1 || u16be(b, 4) === 2)) return 'psd';
    if (startsWith(b, [0x1f, 0x8b]) && ext === 'svgz') return 'svgz';
    if (svgStart(b) >= 0) return 'svg';
    return null;
  }

  /** PNG: an acTL chunk before the first IDAT (APNG). null when the chunks run past the bytes. */
  function pngAnimated(b) {
    for (let pos = 8; has(b, pos, 8);) {
      const type = ascii(b, pos + 4, 4);
      if (type === 'acTL') return true;
      if (type === 'IDAT' || type === 'IEND') return false;
      pos += 12 + u32be(b, pos);
    }
    return null;
  }

  /** GIF: more than one image descriptor. A bounded block walk; null when the bytes end first. */
  function gifAnimated(b) {
    if (!has(b, 0, 13)) return null;
    let pos = 13 + (b[10] & 0x80 ? 3 * (2 << (b[10] & 7)) : 0);
    let images = 0;
    const skipSubBlocks = () => {
      while (pos < b.length && b[pos] !== 0) pos += b[pos] + 1;
      pos++; // the terminator
    };
    while (pos < b.length) {
      const block = b[pos];
      if (block === 0x3b) return false; // trailer
      if (block === 0x21) {
        pos += 2;
        skipSubBlocks();
      } else if (block === 0x2c) {
        if (++images > 1) return true;
        if (!has(b, pos, 10)) return null;
        const flags = b[pos + 9];
        pos += 10 + (flags & 0x80 ? 3 * (2 << (flags & 7)) : 0) + 1; // + the LZW minimum code size
        skipSubBlocks();
      } else {
        return null; // not a block: corrupt
      }
    }
    return null;
  }

  function animatedOf(b, format) {
    switch (format) {
      case 'png': return pngAnimated(b);
      case 'gif': return gifAnimated(b);
      case 'webp': {
        const chunk = ascii(b, 12, 4);
        if (chunk === 'VP8X') return has(b, 20, 1) ? (b[20] & 0x02) !== 0 : null; // the animation flag
        return chunk === 'VP8 ' || chunk === 'VP8L' ? false : null;
      }
      case 'avif': return (ftypBrands(b) || []).includes('avis');
      case 'svg': return null; // SMIL animations run in an <img>; not worth a parse
      default: return format ? false : null;
    }
  }

  /**
   * What the bytes are: {format, byContent, extensionHint, mismatch, animated}. Only the first
   * POLICY.sniffBytes bytes decide the format; `animated` may look further (a GIF's second frame).
   */
  function sniff(bytes, { path } = {}) {
    const b = view(bytes);
    const extensionHint = formatOfPath(path);
    const format = contentFormat(b.subarray(0, POLICY.sniffBytes), extensionOf(path));
    return {
      format,
      byContent: format !== null,
      extensionHint,
      mismatch: !!(format && extensionHint && format !== extensionHint),
      animated: animatedOf(b, format),
    };
  }

  // ---------------------------------------------------------------- dimensions

  const dims = (width, height) => (width > 0 && height > 0 ? { width, height } : null);

  function jpegDims(b) {
    let i = 2;
    for (let n = 0; n < 10000 && i < b.length; n++) {
      if (b[i] !== 0xff) return null;
      while (i < b.length && b[i] === 0xff) i++; // fill bytes
      if (i >= b.length) return null;
      const m = b[i++];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) continue; // markers without a length
      if (m === 0xd9 || m === 0xda) return null; // end of image / start of scan before a frame header
      if (!has(b, i, 2)) return null;
      const len = u16be(b, i);
      if (len < 2) return null;
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) { // SOFn
        return has(b, i, 7) ? dims(u16be(b, i + 5), u16be(b, i + 3)) : null;
      }
      i += len;
    }
    return null;
  }

  function webpDims(b) {
    const chunk = ascii(b, 12, 4);
    if (chunk === 'VP8 ') {
      if (!has(b, 20, 10) || !startsWith(b, [0x9d, 0x01, 0x2a], 23)) return null;
      return dims(u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff);
    }
    if (chunk === 'VP8L') {
      if (!has(b, 20, 5) || b[20] !== 0x2f) return null;
      const [b0, b1, b2, b3] = b.subarray(21, 25);
      return dims(1 + (((b1 & 0x3f) << 8) | b0), 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)));
    }
    if (chunk === 'VP8X') return has(b, 24, 6) ? dims(1 + u24le(b, 24), 1 + u24le(b, 27)) : null;
    return null;
  }

  function bmpDims(b) {
    if (!has(b, 14, 4)) return null;
    if (u32le(b, 14) === 12) return has(b, 18, 4) ? dims(u16le(b, 18), u16le(b, 20)) : null;
    return has(b, 18, 8) ? dims(i32le(b, 18), Math.abs(i32le(b, 22))) : null; // height < 0: top-down
  }

  /** ICO / CUR: the largest entry (a width or height byte of 0 means 256), plus the entry count. */
  function icoDims(b) {
    if (!has(b, 4, 2)) return null;
    const count = u16le(b, 4);
    if (!has(b, 6, 16 * count)) return null; // the whole directory, or the largest may be missing
    let best = null;
    for (let k = 0; k < count; k++) {
      const w = b[6 + 16 * k] || 256;
      const h = b[7 + 16 * k] || 256;
      if (!best || w * h > best.width * best.height) best = { width: w, height: h };
    }
    return best && { ...best, count };
  }

  const ISOBMFF_CONTAINERS = new Set(['meta', 'iprp', 'ipco']);

  /**
   * Every `ispe` (image spatial extents) box in meta / iprp / ipco, depth at most 4. A box running
   * past `end` is cut there (a head read); size 0 = to the end, 1 = a 64-bit size follows.
   */
  function ispeBoxes(b, start, end, depth, found) {
    let pos = start;
    for (let n = 0; n < 1000 && pos + 8 <= end; n++) {
      let size = u32be(b, pos);
      let header = 8;
      if (size === 1) {
        if (pos + 16 > end) return;
        size = u32be(b, pos + 8) * 0x100000000 + u32be(b, pos + 12);
        header = 16;
      } else if (size === 0) {
        size = end - pos;
      }
      if (size < header) return;
      const type = ascii(b, pos + 4, 4);
      const boxEnd = Math.min(pos + size, end);
      if (type === 'ispe' && boxEnd - pos >= header + 12) {
        const d = dims(u32be(b, pos + header + 4), u32be(b, pos + header + 8));
        if (d) found.push(d);
      } else if (ISOBMFF_CONTAINERS.has(type) && depth < 4) {
        ispeBoxes(b, pos + header + (type === 'meta' ? 4 : 0), boxEnd, depth + 1, found); // meta is a full box
      }
      pos += size;
    }
  }

  function isobmffDims(b) {
    const found = [];
    ispeBoxes(b, 0, b.length, 0, found);
    // A grid image lists its tiles too: the largest extent is the canvas.
    return found.reduce((best, d) => (!best || d.width * d.height > best.width * best.height ? d : best), null);
  }

  /** A length in user units: a plain number or px; anything else (%, em, mm) -> null. */
  function svgLength(v) {
    const m = /^\s*(\d*\.?\d+(?:e[+-]?\d+)?)\s*(px)?\s*$/i.exec(v || '');
    const n = m ? Number(m[1]) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  /** SVG: the root's width / height (px or unitless), else from its viewBox. Best effort. */
  function svgDims(b) {
    const start = svgStart(b);
    if (start < 0) return null;
    const s = String.fromCharCode(...b.subarray(start, Math.min(b.length, start + SVG_SNIFF_BYTES)));
    const end = s.indexOf('>');
    if (end < 0) return null;
    const attrs = {};
    for (const m of s.slice(0, end).matchAll(/\s(width|height|viewBox)\s*=\s*(["'])(.*?)\2/g)) {
      if (!(m[1] in attrs)) attrs[m[1]] = m[3];
    }
    let w = svgLength(attrs.width);
    let h = svgLength(attrs.height);
    const vb = (attrs.viewBox || '').trim().split(/[\s,]+/).map(Number);
    if (vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0) {
      if (w && !h) h = (w * vb[3]) / vb[2];
      else if (h && !w) w = (h * vb[2]) / vb[3];
      else if (!w && !h) [w, h] = [vb[2], vb[3]];
    }
    return w && h ? dims(Math.max(1, Math.round(w)), Math.max(1, Math.round(h))) : null;
  }

  /** {width, height} from the header of `bytes` in format `format` (an id), or null. */
  function dimensions(bytes, format) {
    const b = view(bytes);
    switch (format) {
      case 'png': return has(b, 24, 0) && ascii(b, 12, 4) === 'IHDR' ? dims(u32be(b, 16), u32be(b, 20)) : null;
      case 'gif': return has(b, 10, 0) ? dims(u16le(b, 6), u16le(b, 8)) : null;
      case 'jpeg': return jpegDims(b);
      case 'webp': return webpDims(b);
      case 'bmp': return bmpDims(b);
      case 'ico': return icoDims(b);
      case 'avif': case 'heic': return isobmffDims(b);
      case 'psd': return has(b, 22, 0) ? dims(u32be(b, 18), u32be(b, 14)) : null;
      case 'svg': return svgDims(b);
      default: return null;
    }
  }

  // ---------------------------------------------------------------- Git LFS pointers

  const LFS_VERSION = 'version https://git-lfs.github.com/spec/v1\n';

  /**
   * {oid, size} of a Git LFS pointer file: at most POLICY.lfsPointerMax bytes of ASCII text, first
   * line the spec v1 version, `key value` lines, exactly one `oid sha256:<64 hex>` and one
   * `size <decimal>` (other keys are allowed). Else null.
   */
  function parseLfsPointer(bytes) {
    const b = view(bytes);
    if (!b.length || b.length > POLICY.lfsPointerMax) return null;
    if (b.some((c) => c === 0 || c === 0x0d || c > 0x7e)) return null;
    const text = String.fromCharCode(...b);
    if (!text.startsWith(LFS_VERSION)) return null;
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    let oid = null;
    let size = null;
    for (const line of lines) {
      const m = /^([a-z0-9.-]+) (.*)$/.exec(line);
      if (!m) return null;
      if (m[1] === 'oid') {
        const o = /^sha256:([0-9a-f]{64})$/.exec(m[2]);
        if (!o || oid) return null;
        oid = o[1];
      } else if (m[1] === 'size') {
        if (!/^\d{1,15}$/.test(m[2]) || size !== null) return null;
        size = Number(m[2]);
      }
    }
    return oid && size !== null ? { oid, size } : null;
  }

  exports.FORMATS = FORMATS;
  exports.POLICY = POLICY;
  exports.extensionOf = extensionOf;
  exports.formatOfPath = formatOfPath;
  exports.sniff = sniff;
  exports.dimensions = dimensions;
  exports.parseLfsPointer = parseLfsPointer;
})(typeof module !== 'undefined' ? module.exports : (window.PLImageFormat = {})); // NOSONAR(S1121): the CommonJS-or-window export idiom
