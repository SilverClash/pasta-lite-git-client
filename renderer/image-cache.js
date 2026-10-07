'use strict';
// Object-URL cache of the diff view's image preview (plain script; exposes window.PLImageCache, and
// module.exports under node for the tests). docs/plans/image-preview.md §6.4.
//
// The store (renderer/store.js) puts the bytes of every 'image' ImageSide here as it lands and keeps
// only the URL in state.imagePreview, so bytes never sit in a state key (the store compares those
// as JSON). An LRU keyed by RevisionKey (a blob oid, 'wt:<dev:ino:size:mtimeNs>' for a worktree
// file): a git key never changes meaning, so moving back and forth between files or commits never
// re-reads them; a worktree key changes with every save.
//
// create(urlApi = URL, {maxEntries, maxBytes}) -> cache:
//   put(key, bytes, mime) -> url   a blob: URL of `bytes` typed `mime` (the catalogue's, never the
//                                  path's); a key already held keeps its URL (and is touched)
//   get(key) -> url | null         (touches it)
//   has(key)
//   pin(keys)                      the keys on screen (replaces the last set): never evicted
//   clear()                        revoke everything (repo switch, the diff view unmounting)
//   size / bytes                   entries held / their byte total
// Eviction (least recently used first, pinned keys skipped, never the key just put) runs on put and
// pin while the cache holds more than maxEntries or maxBytes; every evicted or cleared URL is
// revoked. urlApi is injected so the tests count createObjectURL / revokeObjectURL without a DOM.
// Only blob: URLs are made: the page's CSP allows them in img-src (renderer/index.html), and a data:
// URL (also allowed) would be the drop-in fallback if a blob: URL ever stopped loading from the
// file:// page (checked in the real app: they load, see docs/plans/image-preview.md "As built (I2)").
(function () {
  const MAX_ENTRIES = 24;
  const MAX_BYTES = 256 * 1024 * 1024;

  function create(urlApi = URL, { maxEntries = MAX_ENTRIES, maxBytes = MAX_BYTES } = {}) {
    const entries = new Map(); // key -> {url, size}, least recently used first
    let pinned = new Set();
    let total = 0;

    const touch = (key, e) => {
      entries.delete(key);
      entries.set(key, e);
    };

    function drop(key) {
      const e = entries.get(key);
      entries.delete(key);
      total -= e.size;
      urlApi.revokeObjectURL(e.url);
    }

    /** Evict down to the limits, least recently used first; pinned keys and `keep` (just put: its URL is handed out) stay. */
    function evict(keep = null) {
      for (const key of [...entries.keys()]) {
        if (entries.size <= maxEntries && total <= maxBytes) return;
        if (!pinned.has(key) && key !== keep) drop(key);
      }
    }

    function put(key, bytes, mime) {
      const held = entries.get(key);
      if (held) {
        touch(key, held);
        return held.url;
      }
      const url = urlApi.createObjectURL(new Blob([bytes], { type: mime }));
      const size = bytes.byteLength || 0;
      entries.set(key, { url, size });
      total += size;
      evict(key);
      return url;
    }

    function get(key) {
      const e = entries.get(key);
      if (!e) return null;
      touch(key, e);
      return e.url;
    }

    function pin(keys) {
      pinned = new Set((keys || []).filter(Boolean));
      evict();
    }

    function clear() {
      for (const key of [...entries.keys()]) drop(key);
      pinned = new Set();
    }

    return {
      put, get, pin, clear,
      has: (key) => entries.has(key),
      get size() { return entries.size; },
      get bytes() { return total; },
    };
  }

  const api = { create, MAX_ENTRIES, MAX_BYTES };
  if (typeof window !== 'undefined') window.PLImageCache = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
