# Pasta Lite: image preview in the diff view

Plan for showing images instead of "Binary file — no preview" when a changed or committed image
is selected. It covers the WIP panel (unstaged, staged and untracked files) and the commit details
panel (commits and stashes): before and after side by side, metadata, zoom, then comparison modes,
text-backed images (SVG, Git LFS pointers) and, as a gated last step, formats Chromium can't decode.

Status: **I1–I4 built** on `feat/image-preview` (the backend, the side-by-side preview in the
renderer, then text-backed and conflicted images, the local Git LFS cache, the comparison modes,
zoom steps and keys, then HEIC / TIFF / PSD through the OS thumbnailer). Written 2026-10-07 (from
`0.2.1`, `debfb3a`). Where I1, I2, I3 and I4 differ from this plan, §5.7, §6.7, §6.8 and §7.3 say
what was built and why. It builds on the diff pipeline (`src/diff-args.js`, `src/diff-view.js`, `src/hunks.js`,
`renderer/components/diff-view.js`, `renderer/components/diff-model.js`), the op registry and runner
(`src/ops.js`, `src/runner.js`), the IPC table (`src/ipc-contract.js`) and the store contract
(`renderer/store.js`). The roadmap lists this as "image diff" under **Diff: split, whitespace, word
wrap, image diff**, Partial, "Later (P4 stretch)" ([roadmap.md](roadmap.md) line 81). This plan
pulls the image part forward on its own.

**Sources.**
- The code, read directly (file and line numbers below are from `debfb3a`).
- git facts marked **(verified)** were checked with git 2.51.2 in throwaway repositories under the
  session scratchpad, not this repo.
- Library facts come from the npm registry (`npm view`, 2026-10-07) and the sharp and Electron docs.
- Chromium version: Electron 44.4.5 (the pinned devDependency) ships **Chrome 152.0.7977.130**
  (read from the Electron Framework binary in `node_modules`).

**Size scale** (the same LOC style as rebase.md and roadmap.md, tests included): **S** < 500 LOC,
**M** 500–1,500, **L** 1,500–3,000.

---

## 1. Summary

### 1.1 Root cause: why a `.webp` says "Binary file — no preview"

**No format gets a preview today.** WebP isn't missing from an allow-list. There is no image
preview anywhere in the renderer (no `<img>` is ever created, and `git grep -n "img"` over
`renderer/` finds nothing). PNG, JPEG and GIF end up at the same message.

The pipeline, end to end:

1. **The renderer asks for a text patch.** `renderer/store.js:681-685` `fetchDiff` invokes the op
   `commitDiffView(sha, file, orig)` or `workdirDiffView(file, {staged, untracked, orig})` through
   `window.api.invoke` (`preload.js:62`) → the single `op` channel (`src/ipc-contract.js:79`) →
   `main/ipc.js:114-116` → `runner.run` → `src/ops.js:121` / `:127-131`.
2. **git produces the patch.** `src/git.js:464-468` `diffCommitFile` and `:481-491` `diffWorkdir`
   take their argv from `src/diff-args.js:18-27`. Every patch command uses
   `DIFF_OPTS = ['--no-ext-diff', '--no-textconv', '--no-color', '-U3']`
   (`src/git-process.js:97`) and is read as latin1 (`src/diff-args.js:10`). There is no `--binary`,
   so git prints no content for binary files.
3. **git decides "binary".** git treats a blob as binary when its first 8,000 bytes contain a NUL,
   or when `.gitattributes` says `binary` / `-diff`. Every raster format has NULs in its header.
   WebP starts `RIFF <chunk size, little-endian u32> WEBP`, and the high bytes of that size are
   `00` for any file under 16 MB. PNG's IHDR length is `00 00 00 0D`. For such a file git prints
   one line instead of hunks **(verified)**:
   ```
   diff --git a/a.webp b/a.webp
   index 5e2d3e0..1b17665 100644
   Binary files a/a.webp and b/a.webp differ
   ```
   An untracked file (`diff --no-index -- /dev/null c.webp`, exit 1) gives
   `Binary files /dev/null and b/c.webp differ` **(verified)**. An SVG is text, so it gets a normal
   text diff, unless `.gitattributes` marks it `binary`. Then it gets the same binary line
   **(verified)**.
4. **The parser flags it.** `src/hunks.js:152` (`'Binary files '`) and `:158-160`
   (`GIT binary patch`) set `file.isBinary = true` and leave `hunks: []`.
5. **The display model passes it on.** `src/diff-view.js:75-78` copies `isBinary` into the
   section, and `:95` leaves `fingerprint` null for a binary file (so no hunk staging).
6. **The renderer shows the message.** `renderer/components/diff-view.js:389-391`: one section with
   no hunks → `message(D.emptyText(sections[0]), 'binary')`. `renderer/components/diff-model.js:46`
   returns `'Binary file — no preview'`. The header adds a `binary` badge (`diff-view.js:193`), and
   for a working-copy diff the staging note says "Binary file — stage it as a whole with Stage
   File" (`diff-model.js:193`).

Nothing in this chain ever reads the blob bytes. The fix is a **new read path** for the bytes of
the two revisions, plus a preview in the diff body. Changing the text diff isn't the fix:
`--binary` or textconv would break the rule that the displayed patch is byte-for-byte the one
hunk staging indexes (`src/diff-args.js:2-5`).

### 1.2 Milestones

| Milestone | Scope | Size |
|---|---|---|
| **I1** | Backend: the `ImageFormat` catalogue and magic-byte sniffer (`src/image-format.js`, shared with the renderer like `src/error-kinds.js`), the blob-revision reader (git blobs, the index, the worktree, with size caps and path guards) and two read ops, `commitImageSide` and `workdirImageSide`. No visible change | M (~1.1k LOC, ~55% tests) |
| **I2** | The visible fix: Tier 1 formats (PNG, APNG, JPEG, GIF, WebP, AVIF, BMP, ICO/CUR, SVG) side by side in the diff body. Metadata and size delta, checkerboard, Fit / 100% zoom, loading / too-large / LFS / corrupt states, the CSP `blob:` change, cancellation, a blob-keyed object-URL cache, CHANGELOG and README | M (~1.4k LOC) |
| **I3** | Text-backed images and comparison: a Preview / Text toggle for SVG and Git LFS pointers, LFS objects read from the local LFS cache (never the network), swipe / onion skin / difference modes, zoom shortcuts, ours / theirs preview for conflicted binary images, demo-repo images and a smoke script | M (~1.3k LOC) |
| **I4** *(gated, Q2)* | Tier 2 formats (HEIC/HEIF, TIFF, PSD). Recommended: the OS thumbnailer (`nativeImage.createThumbnailFromPath`, macOS and Windows, no dependencies). The alternative is pure-JS/WASM decoders in a worker thread. JPEG XL only once Chromium turns it on by default | S (OS thumbnailer) / M (decoders) |

### 1.3 Key decisions

1. **The text diff stays as it is.** Images get a **second, independent read** (blob bytes), never
   a change to `DIFF_OPTS` or `src/diff-args.js`. Hunk staging's byte-for-byte contract is
   untouched.
2. **Content decides the format; the extension is only a hint.** Magic bytes are the source of
   truth (`src/image-format.js`). A `.png` holding JPEG bytes previews as JPEG, with a "content is
   JPEG" note. A `.webp` holding text is `not-image`, and the current binary message stays. The
   MIME type handed to Chromium comes from the sniffed format, never from the file name.
3. **No new IPC channel.** The new reads are two more ops in `ops.OPS`, so they inherit the sender
   check, repo injection, `relPath` validation, the bare-repository gate, logging and opId
   cancellation (`src/ipc-contract.js:65-70`, `main/ipc.js:114-116`). Bytes cross IPC as a Node
   `Buffer` and arrive as a `Uint8Array`. Structured-clone types are supported through
   `contextBridge` and `ipcRenderer.invoke` (Electron docs: context-bridge "Cloneable Types";
   breaking-changes: Buffers are sent over IPC as `Uint8Array`).
4. **The renderer decodes Tier 1.** Chromium 152 decodes PNG/APNG, JPEG, GIF, WebP (animated
   included), AVIF, BMP, ICO and SVG natively. The bytes become a `Blob` with the sniffed MIME
   type, then an object URL on an `<img>`. **SVG goes only through `<img>`**: Chromium renders
   SVG-as-image in secure static mode, with no script, no event handlers and no external fetches.
   It is never inlined into the DOM, an `<object>`, an `<iframe>` or `innerHTML`.
5. **Each side is a result, not an error.** `too-large`, `lfs-pointer`, `absent`, `special`
   (symlink or submodule), `unsupported` and `not-image` are states of an `ImageSide`, the same way
   a rebase stop is a result in rebase.md (decision 3). Errors stay for refusals and failures, with
   existing kinds (`invalid-args`, `outside`, `symlink`, `aborted`). No new error kind is needed.
6. **Tier 2 stays out of v1, and no native module ships.** The app has **no runtime dependencies**
   today. `package.json` has only `devDependencies`, `build.files` lists no `node_modules`, and
   `"npmRebuild": false`. CONTRIBUTING.md:166-170 says it "has no native modules, loads no unsigned
   libraries". `sharp` would break all three, and its prebuilt binaries **can't decode HEIC**
   anyway (§7.2). Tier 2 is I4, behind Q2.
7. **Bytes never enter `state.diff`.** The store compares diff reloads with
   `sameJSON(d.data, data)` (`renderer/store.js:699`). A 30 MB `Uint8Array` there would be
   stringified on every watcher refresh. Previews get their own store key, `imagePreview`, and a
   blob-keyed cache.

---

## 2. Domain model (DDD, mapped onto the real layout)

### 2.1 Bounded context

**Diff Presentation**, with **File Preview** as its new subdomain. It already owns "how a change
to one file is shown" (`src/diff-view.js`: "The diff view the renderer shows"). Image preview is a
second presentation of the same `DiffSpec`: the same file, the same two revisions, different bytes
read. It does not own staging (the Working Copy context in `src/hunks.js`, `src/git.js`), and it
reads but never writes the repository.

The codebase has no `domain/` / `infrastructure/` folders, and none are invented here. The DDD
roles map onto the layering it already uses (CONTRIBUTING.md "Architecture"):

| DDD role | Where it lives (existing pattern) | New for images |
|---|---|---|
| Domain (pure, no I/O, Node + browser) | `src/error-kinds.js` (CommonJS-or-window), `src/diff-view.js` (pure display model) | `src/image-format.js`: `ImageFormat` catalogue, `sniff`, `dimensions`, `parseLfsPointer`, `PreviewPolicy` constants |
| Domain service (pure) | `src/diff-view.js` `diffView(raw)` | `src/image-preview.js` `imageSide(revision, bytes, policy)` → `ImageSide` |
| Port / adapter (git and fs, Node) | `src/git.js`, `src/hunks.js` `indexEntry` / `headEntry`, `src/undo.js` `blobChunks`, `src/worktree-fs.js` | `src/blob-revisions.js`: resolves a `DiffSpec` side to a `BlobRevision` and reads its bytes with caps |
| Application service (validation + composition) | `src/ops.js` READ descriptors, `src/op-validators.js` | ops `commitImageSide`, `workdirImageSide` |
| Transport (IPC contract) | `src/ipc-contract.js` `op` channel, `preload.js` `invoke` / `invokeCancellable` | **none new** |
| Presenter / view model (pure renderer) | `renderer/components/diff-model.js` (`window.PLDiff`) | `renderer/components/image-model.js` (`window.PLImage`): `wantsPreview`, labels, deltas, zoom math |
| View (DOM) | `renderer/components/diff-view.js`, `diff-staging.js` (`PLDiffStaging.create`) | `renderer/components/image-preview.js` (`window.PLImagePreview.create`), `image-preview.css` |
| Renderer state | `renderer/store.js` keys + actions | key `imagePreview`, actions `loadImagePreview` / `closeImagePreview`, `renderer/image-cache.js` (`window.PLImageCache`) |

### 2.2 Ubiquitous language

| Term | Meaning | Shape / values |
|---|---|---|
| **DiffSpec** | What the diff view shows; already exists (`renderer/store.js:46`) | `{kind:'workdir', file, staged, untracked, orig?}` \| `{kind:'commit', sha, file, orig?}` |
| **Side** | One of the two revisions being compared | `'old'` (before) \| `'new'` (after) |
| **BlobSource** | Where a side's bytes come from | `'commit'` (a tree in history), `'head'` (HEAD's tree), `'index'` (stage 0, or stages 1–3 in I3), `'worktree'` (the file on disk), `'lfs-cache'` (I3) |
| **BlobRevision** | One resolved side, before reading | `{side, source, oid \| null, mode, size, statKey?, abs?, absent?, special?}`: `oid` for git objects, `statKey` (`dev:ino:size:mtimeNs`) and `abs` for the worktree (main only, never sent) |
| **RevisionKey** | Cache and identity key of a side's bytes | `oid` for git sides, `wt:<statKey>` for the worktree, `lfs:<sha256>` for LFS (I3) |
| **ImageFormat** | A catalogue entry | `{id, label, mime, tier: 1 \| 2 \| 'probe', extensions, animatable}`, e.g. `{id:'webp', label:'WebP', mime:'image/webp', tier:1, extensions:['webp'], animatable:true}` |
| **FormatMatch** | What sniffing concluded | `{format \| null, byContent: boolean, extensionHint \| null, mismatch: boolean, animated?: boolean}` |
| **PreviewKind** | How a side can be shown (the `ImageSide` state) | `'image'` (Tier 1, bytes attached), `'absent'` (added or deleted: no such side), `'too-large'`, `'lfs-pointer'`, `'unsupported'` (a recognised Tier 2 format, no decoder), `'not-image'` (content isn't a known image), `'special'` (symlink 120000, submodule 160000) |
| **ImageSide** | The value object the op returns for one side | `{side, kind, source, key, size, format, extensionHint, mime, mismatch, dims \| null, animated: true \| false \| null}`, plus `bytes` (`image`), `lfs: {oid, size}` (`lfs-pointer`), `soft`, `limit: 'size' \| 'svg' \| 'pixels'`, `max` (`too-large`); or `{side, key, unchanged: true}` (§5.7) |
| **PreviewPolicy** | The limits and rules, one frozen object | §5.3 |
| **ImagePreview** | The renderer's aggregate for one DiffSpec | `{specKey, old: SideSlot, new: SideSlot}`; `SideSlot = {loading, side: ImageSide (no bytes) \| null, url \| null, error \| null, decoded?: {width, height}}` |
| **ImageDelta** | Derived comparison | `{bytes: new.size − old.size, pct, dimsChanged, formatChanged}` |
| **ViewMode** | How the panes are drawn | `'side-by-side'` (I2), `'swipe'`, `'onion'`, `'difference'` (I3) |
| **Zoom** | Scale | `'fit'` (shrink to fit, never enlarge) \| a number (1 = 100%) |

### 2.3 Invariants

- An `ImageSide` with `kind: 'image'` always has `bytes`, a Tier 1 `format` and a `mime` from the
  catalogue. Nothing else carries bytes. `unchanged: true` carries no bytes (§5.5).
- `mime` is never derived from the path.
- A `special` side (mode 120000 / 160000) is never read: a symlink's "content" is its target path.
  `src/hunks.js` refuses those modes for the same reason (`refuseSpecial`, `src/hunks.js:373-378`).
- The worktree is read only after `worktreeGuard(...).check(rel)` (`src/worktree-fs.js:44-74`),
  with `O_NOFOLLOW` and a regular-file check, and never past `PreviewPolicy.maxBytes`.
- An untracked file is read only if `git ls-files --others --exclude-standard` lists exactly that
  path. This is the same rule `diffWorkdir` applies before `diff --no-index`
  (`src/git.js:484-488`, `:494-498`).

---

## 3. Formats

### 3.1 Tiers

| Format | Tier | Magic bytes (sniff) | MIME given to the `<img>` | Notes |
|---|---|---|---|---|
| PNG / APNG | 1 | `89 50 4E 47 0D 0A 1A 0A` | `image/png` | APNG = an `acTL` chunk before `IDAT` → `animated: true` |
| JPEG | 1 | `FF D8 FF` | `image/jpeg` | Chromium applies EXIF orientation (`image-orientation: from-image`), so displayed size comes from `naturalWidth`/`naturalHeight`, not the SOF header |
| GIF | 1 | `GIF87a` / `GIF89a` | `image/gif` | Animated when there is more than one image descriptor (`0x2C`); a bounded scan |
| WebP | 1 | `RIFF....WEBP` (bytes 0–3, 8–11) | `image/webp` | `VP8 ` / `VP8L` / `VP8X`; VP8X flag bit 1 = animation |
| AVIF | 1 | ISO-BMFF `ftyp` at offset 4, major or compatible brand `avif` / `avis` | `image/avif` | `avis` = an image sequence (animated) |
| BMP | 1 | `BM` + a plausible DIB header size (12, 40, 52, 56, 108, 124) | `image/bmp` | Height may be negative (top-down) |
| ICO / CUR | 1 | `00 00 01 00` / `00 00 02 00` + count ≥ 1 | `image/x-icon` | Shows the image Chromium picks; metadata lists the entry count |
| SVG | 1 (sandboxed) | Text: optional BOM, whitespace, `<?xml …?>`, comments, `<!DOCTYPE svg…>`, then `<svg` within the first 4 KiB | `image/svg+xml` | `<img>` only (§6.2). `.svgz` (gzip `1F 8B`) → `unsupported` (Q6) |
| HEIC / HEIF | 2 | `ftyp` brand `heic` `heix` `hevc` `hevx` `heim` `heis` `hevm` `hevs`, or `mif1` / `msf1` with a HEVC compatible brand | – | `unsupported` until I4 |
| TIFF | 2 | `II*\0`, `MM\0*` (BigTIFF `II+\0`, `MM\0+`) | – | `unsupported` until I4 |
| PSD / PSB | 2 | `8BPS` + version 1 / 2 | – | `unsupported` until I4 |
| JPEG XL | probe | codestream `FF 0A`, container `00 00 00 0C 4A 58 4C 20 0D 0A 87 0A` | `image/jxl` | Chromium 145+ has a jxl-rs decoder behind `chrome://flags/#enable-jxl-image-format`, off by default as of the latest reports (Phoronix on Chrome 145; a July 2026 status review). Treated as `unsupported` unless a runtime probe (§3.3) decodes a tiny sample |
| Git LFS pointer | – | text starting `version https://git-lfs.github.com/spec/v1\n`, at most 1,024 bytes, with `oid sha256:<64 hex>` and `size <n>` lines | – | `lfs-pointer` (§4.4) |

### 3.2 Sniffing and dimensions (`src/image-format.js`)

- `sniff(bytes, {path})` reads at most `PreviewPolicy.sniffBytes` (64 KiB) from the start. It
  returns a `FormatMatch`. The extension (lower-cased, after the last `.` of the basename) is only
  compared to set `extensionHint` and `mismatch`. A known image extension whose content matches
  nothing gives `{format: null, extensionHint}` → `not-image`.
- `dimensions(bytes, format)` → `{width, height} | null`, header only, no decoding: PNG IHDR,
  GIF logical screen, JPEG first SOFn (skipping APPn / EXIF segments with bounded marker walking),
  WebP VP8/VP8L/VP8X canvas, BMP DIB header (absolute height), ICO largest entry (0 = 256), AVIF /
  HEIF `ispe` box (a bounded box walk, depth ≤ 4), SVG `width`/`height` attributes or `viewBox`
  (best effort, may be null). This is used for the pixel cap and for the `too-large` metadata. The
  pane label uses the decoded `naturalWidth` / `naturalHeight` once the `<img>` loads.
- Every parser is bounds-checked and returns null on a short or odd buffer, never throws. These are
  hostile bytes.
- The module is pure and dependency-free, and exports through `module.exports` and
  `window.PLImageFormat`, exactly like `src/error-kinds.js`. The renderer uses only the catalogue
  (labels, the `tier`); sniffing happens in main.

### 3.3 The JPEG XL probe (I4, optional)

`PLImage.probeFormat('jxl')` decodes an embedded ~20-byte JXL sample with `new Image()` +
`img.decode()` once per page. If Chromium can decode it, `jxl` is treated as Tier 1 for that
session. No Chromium feature switch is turned on (Q7).

---

## 4. Git and the worktree (the `BlobRevision` adapter)

### 4.1 Resolving each side

All git reads run at the worktree root through `exec.out` (`src/exec.js:25-30`), with
`LITERAL_ENV` for pathspecs. Path entries are matched **exactly**, as `src/hunks.js:336-356`
`indexEntry` / `headEntry` already do. Those two helpers aren't exported
(`src/hunks.js:524-530`). I1 moves them into `src/blob-revisions.js` (or exports them), and
`hunks.js` keeps calling them, so nothing is duplicated.

| DiffSpec | `old` side | `new` side |
|---|---|---|
| `commit {sha, file, orig?}` | `ls-tree -l -z <base> -- <orig ?? file>`, where `<base>` = `baseOf(sha)`: first parent, or the empty tree for a root commit (`src/git.js:40-42`, `src/git-reads.js:20-26`) | `ls-tree -l -z <sha> -- <file>` |
| `workdir` unstaged, tracked | the index, stage 0 (`ls-files -s -z -- <file>`), size from `cat-file --batch-check` | the worktree file |
| `workdir` untracked | `absent` | the worktree file, after the `isUntracked` check |
| `workdir` staged | `ls-tree -l -z HEAD -- <orig ?? file>`; `absent` when HEAD is unborn (`headState(...).sha` null) | the index, stage 0 |
| `workdir` conflicted (I3) | stage 2 (ours) | stage 3 (theirs); stage 1 (base) is offered as a third pane |
| a stash (it is a `commit` spec) | first parent = HEAD when stashed | the stash commit (the stashed worktree) |

- `ls-tree -l` gives mode, type, oid **and size** in one call **(verified:
  `100644 blob 5e2d3e06…      34\ta.webp`)**. `cat-file --batch-check` accepts `HEAD:path`,
  `:path` and `:0:path` **(verified)**, but `<rev>:<path>` puts the path in a revision string, so
  ls-tree / ls-files with literal pathspecs are used instead.
- No entry in the tree → `absent` (an added file's `old`, a deleted file's `new`). An unstaged
  deletion: the worktree file is missing → `absent`.
- Type `commit` (mode 160000) or mode 120000 → `special`, never read.
- Renames: `orig` is validated by `relPath(orig, 'orig')`, as `commitFileArgs` / `workdirOpts`
  already do (`src/ops.js:184-195`).
- An unmerged path in I1/I2: `workdirDiffView` already returns a `conflict` view, and the preview
  isn't requested (`wantsPreview` is false). I3 adds stages 1–3.

### 4.2 Reading bytes

- **Git blobs**: `cat-file blob <oid>` with `{encoding: 'buffer', maxBytes: size + 4096}`. The
  runner's ambient signal applies (`src/git-process.js:160-237`), so a cancel kills git, and the
  existing `too-large` kill is a second guard behind the size check. The size comes from `ls-tree
  -l` or `--batch-check` **before** the read: an over-cap blob is never read at all.
- **The worktree**: `worktreeGuard(repo).check(rel)` (refuses `..`, `.git`, absolute paths, any
  symlinked component, anything resolving outside the worktree or into a git dir; kinds
  `outside` / `symlink`), then `fs.promises.open(abs, O_RDONLY | O_NOFOLLOW)`, `fh.stat()`. Not a
  regular file → `special`. Over the cap → `too-large` (with a 64 KiB head read for the sniff).
  Otherwise read at most `size` bytes. This is the async, capped counterpart of `readNoFollow`
  (`src/worktree-fs.js:81-94`), which reads the whole file synchronously and has no cap, so it
  isn't reused as is.
- **Filters**: `cat-file blob` returns the stored bytes, without smudge filters, so an LFS-tracked
  file's index or commit side is the pointer (§4.4). The worktree side is the checked-out file
  (the real image when LFS is installed). No filter driver, textconv or external program ever runs
  for a preview.

### 4.3 Size, pixel and time policy

See `PreviewPolicy` (§5.3): the soft cap 20 MB per side (a "Load preview" button), the hard cap
50 MB (never read; the same as `DIFF_VIEW_MAX_RAW`, `src/diff-view.js:19`), SVG 5 MB, and
100 megapixels by header. No timeout: reads are cancellable instead (§5.6).

### 4.4 Git LFS pointer files

- A pointer is ≤ 1,024 bytes of text, so its diff is a **text diff** (oid / size lines), not the
  binary message. `wantsPreview` (§5.2) also triggers on image extensions for text diffs, so the
  pointer is recognised.
- I2: a pointer side → `kind: 'lfs-pointer'`, `lfs: {oid, size}`. The pane says "Stored in Git LFS
  (2.4 MB) — not loaded" plus the short oid. The worktree side of an LFS file is usually the real
  image and previews normally.
- I3: read the object from the **local** LFS cache only:
  `<git-common-dir>/lfs/objects/<oid[0:2]>/<oid[2:4]>/<oid>`. The path is built from a validated
  `/^[0-9a-f]{64}$/` oid, read with `O_NOFOLLOW`, its sha256 checked against the oid, and
  `PreviewPolicy` applied (source `lfs-cache`). A missing object stays `lfs-pointer` with "Not
  downloaded". **No `git lfs` process, smudge or network fetch** (Q3). A custom `lfs.storage` is
  not followed in I3.

---

## 5. Backend design (I1)

### 5.1 New files

```
src/image-format.js     pure: FORMATS catalogue, sniff, dimensions, parseLfsPointer, POLICY (CommonJS + window.PLImageFormat)
src/blob-revisions.js   adapter: resolveSide(repo, spec, side) -> BlobRevision; readRevision(repo, rev, {maxBytes, signal}) -> Buffer
src/image-preview.js    pure: imageSide(rev, bytes|head, {policy, path, force}) -> ImageSide (applies PreviewPolicy, sniff, LFS)
```

### 5.2 Ops (`src/ops.js` READ)

```js
// Bytes of one side of a commit file diff, as an ImageSide (§2.2). bare: true (trees only).
commitImageSide: read(async (repo, commit, file, orig, side, o) => ..., { bare: true }),
// One side of a working-copy file diff; spec options as workdirDiffView. Needs a worktree.
workdirImageSide: read(async (repo, file, wo, side, o) => ...),
```

- Arguments are checked like their diff twins: `commitFileArgs` (`src/ops.js:184`),
  `relPath` + `workdirOpts` (`src/ops.js:187-195`). `side` is `'old' | 'new'`, else
  `invalid-args`. Options `{knownKey?: string ≤ 200 chars, force?: boolean}` go through
  `op-validators.opts`, picked explicitly and never spread.
- Descriptors use `read(...)`, so no write queue and no busy / changed events. `bare: true` only for
  `commitImageSide`. `workdirImageSide` falls into `WORKTREE_OPS` automatically
  (`src/ops.js:655`), which keeps `test/bare.test.js:108` passing.
- **Why two ops per side, not one per diff:** the two sides load in parallel and fail
  independently. A 45 MB `old` doesn't hold back a 30 KB `new`, and each IPC message stays under
  one cap.
- `knownKey`: when the resolved `RevisionKey` equals it, the op returns
  `{side, key, unchanged: true}` without reading bytes. A watcher refresh then costs one
  `ls-tree` / `ls-files` / `fstat` per side.
- `force: true` lifts the **soft** cap (the "Load preview" button). The hard cap stays.

### 5.3 `PreviewPolicy`

```js
POLICY = Object.freeze({
  sniffBytes: 64 * 1024,
  softMaxBytes: 20 * 1024 * 1024,   // over it: 'too-large' with {soft: true}; force loads it
  maxBytes: 50 * 1024 * 1024,       // never read (= DIFF_VIEW_MAX_RAW)
  svgMaxBytes: 5 * 1024 * 1024,     // SVG is parsed as XML by the page's renderer process
  maxPixels: 100_000_000,           // header dimensions; over it: 'too-large' {pixels: true}
  lfsPointerMax: 1024,
});
```

The numbers are Q1. The caps are per side.

### 5.4 Errors

Only existing kinds (`src/error-kinds.js`): `invalid-args` (arguments), `outside` / `symlink` (the
worktree guard), `stale` (a worktree path that is neither in the index nor listed as untracked, or
a file that changed between resolving and reading it), `conflict` (an unmerged path: the index has
no stage 0), `aborted` (cancelled), `bare-repo` (the gate, for `workdirImageSide`). Every "can't preview" outcome is an `ImageSide.kind`.
`test/error-kinds.test.js` stays green with no catalogue change.

### 5.5 Main-process cost

- git does the blob I/O in a child process. Main only concatenates chunks
  (`src/git-process.js:200-206, 225`). The worktree read is `fs.promises`. Nothing blocks the event
  loop except the structured clone of the reply (≤ 20 MB by default: a memcpy, a few ms).
- No cache in main: the ops are stateless. Caching is the renderer's job, by `RevisionKey`
  (§6.4). `knownKey` avoids re-sending unchanged bytes.

### 5.6 Cancellation and staleness

The store runs each side with `api.invokeCancellable(opId, …)` (`preload.js:66`). Reads with an
opId are cancellable while running, and their git processes are killed (`src/runner.js` header).
When the spec changes (another file, j/k in the graph, close), the store calls `app.cancel` for
the outstanding opIds and bumps a generation counter. Only the latest generation lands, the same
guard as `diffGen` (`renderer/store.js:688-693`).

### 5.7 As built (I1)

What I1 actually ships, where it differs from or pins down §2–§5. The renderer (I2) builds on this.

**Ops** (`src/ops.js` READ). Both are `op(check, act)`, so the arguments are checked before
anything runs, and the act gets the runner's signal, which lets the worktree read stop on cancel
too:

```js
commitImageSide(commit, file, orig, side, {knownKey?, force?})   // bare: true
workdirImageSide(file, {staged?, untracked?, orig?}, side, {knownKey?, force?})
// -> ImageSide | {side, key, unchanged: true}
```

`commit` is a full object id. `file` and `orig` pass `relPath` (`orig` may be null). `side` is
`'old'` or `'new'`. `knownKey` is a non-empty string of at most 200 characters, and only `true`
counts for `force`. `untracked` wins over `staged`, as in `diffWorkdir`.

**ImageSide** (the `src/image-preview.js` header). Every side has `{side, kind, source, key, size,
format, extensionHint, mime, mismatch, dims, animated}`:
- `source`: `'commit'`, `'head'`, `'index'` or `'worktree'`. `key`: the blob oid,
  `wt:<dev:ino:size:mtimeNs>`, or null when absent. `size` in bytes (null when absent or special).
- `format` and `extensionHint` are catalogue ids (`FORMATS[id].label` for the pane). `mime` is set
  only for `image`, else null.
- `dims`: `{width, height}` from the header (ICO / CUR add `count`, the number of entries), or
  null when unknown. `animated`: `true`, `false`, or `null` when unknown (SVG, or the bytes end
  first).
- `too-large` adds `soft` (true: Load preview, i.e. `force`, will load it), `limit` (`'size'`,
  `'svg'` or `'pixels'`) and `max` (that limit, in bytes or pixels). The plan's `{soft: true}` /
  `{pixels: true}` became this one shape.
- `lfs-pointer` adds `lfs: {oid, size}`, and `image` adds `bytes`.
- `not-local` (added after the I4 review): a git blob a partial clone (`--filter=blob:none`) hasn't
  downloaded. Key and size are null, so the renderer never sends it as `knownKey` and a reload asks
  again (the blob may have been fetched since). `PLImage` shows it as a pane (it is in `VISUAL`, so
  never the binary message) saying "Not downloaded in this partial clone — no preview", with no size
  and no delta; the badge ignores it (the extension decides, as while loading). The store's
  `knownKeyOf` sends no key for it, so every reload reads it again (`test/store.test.js`).

**Deviations and decisions**
- **What `force` lifts**: only the soft byte cap. The SVG cap and the pixel cap are hard, like the
  50 MB cap ("Too large to preview").
- **Sides over the cap**: a git blob is **not read at all**, not even its head (`cat-file`
  can't stop after 64 KiB without failing), so its format is unknown. It is `too-large` when the
  file name has an image extension, else `not-image`, so a 30 MB `.zip` never offers "Load
  preview". A worktree file reads its first `sniffBytes`, so its `too-large` has `format` and
  `dims`.
- **No pixel cap for SVG**: its `width` / `height` don't decide what Chromium rasterizes (the
  visible size does). The 5 MB SVG cap applies.
- **The catalogue**: tier 2 and probe entries have `mime: null`, so they can never reach a Blob.
  `.svgz` is a tier 2 entry (`svgz`), recognised only by gzip bytes plus the `.svgz` extension
  (gzip alone is no image), so it says "SVGZ — preview not supported" (Q6). The backend returns
  JPEG XL (`jxl`, tier `'probe'`) as `unsupported` (Q7); a renderer probe (§3.3) would need an op
  option to send its bytes. HEIC (every HEVC brand, and `mif1` / `msf1` with one), TIFF (BigTIFF
  too) and PSD / PSB are recognised for I4, with `dims` for HEIC (`ispe`) and PSD.
- **The worktree read** compares the open file's `fstat` with the stat key resolved just before
  (`dev:ino:size:mtimeNs`, BigInt stats), and again after the last read (so a same-size save in
  place while it is read is caught too: its mtime moves). If the file was saved in between, or a
  parent folder was swapped for a link, the read fails `stale` instead of returning other bytes. The
  watcher's reload then retries.
- **Partial clones** (after the I4 review): every blob read of the preview (`ls-tree -l`,
  `cat-file --batch-check`, `cat-file blob`) runs with `GIT_NO_LAZY_FETCH=1`, so a blob the clone
  doesn't have is never fetched from the promisor remote: `ls-tree -l` prints its size as `BAD` and
  batch-check says `missing` (git 2.51.2, checked in a `file://` blobless clone), and the side is
  `not-local`. `headEntry` (hunks.js) asks `ls-tree` without `-l` again, so it reads no blob.
- **A tracked symlink in the worktree** is `special` (the guard runs with `allowFinalLink`), not a
  `symlink` error. A path *through* a symlinked folder is still refused.
- **Intent-to-add** (`git add -N`): the index side is the empty blob, so `not-image` with size 0.
  The diff section says "new file", so the view should treat it like `absent`.
- **Moved code**: `indexEntry` / `headEntry` moved from `src/hunks.js` to `src/blob-revisions.js`,
  and hunks.js imports them (`headEntry` is now built on `treeEntry` without sizes, with the same
  results and the same `ls-tree` call as before).
  `baseOf` moved from `src/git.js` to `src/git-reads.js`, which exports it.
- **Lint**: `src/image-format.js` is already in `eslint.config.js`'s renderer block, and
  `PLImageFormat` in `RENDERER_GLOBALS` (the first half of I2 task 4), because the
  `window.PLImageFormat` export needs them. The `<script>` tag and loading it in the harness are
  still I2's.
- **Tests**: `test/image-format.test.js`, `test/image-preview.test.js`, and a builder module,
  `test/image-fixtures.js` (minimal valid bytes per format, shared by both). Small caps go through
  `require('src/image-preview').testHooks.policy`. `test/ops-in-progress.test.js` lists
  `workdirImageSide` among the working-tree ops no flow gates (`NO_FLOW`), like `workdirDiffView`.

**Decided for v1** (§13): the caps as proposed (Q1); Git LFS from the local cache only, never the
network (Q3, I3); `.svgz` unsupported (Q6); JPEG XL not enabled (Q7); binary units, 1 KB =
1,024 B (Q8); HEIC / TIFF / PSD through the OS thumbnailer in I4 (Q2, option A).

---

## 6. Renderer design (I2, I3)

### 6.1 When to preview (`PLImage.wantsPreview(spec, data)`, pure)

True when the diff has loaded with **exactly one section**, no `conflict` (I3: conflicts allowed
when that section is binary), no mode 120000 / 160000 on either side (`isSpecial`,
`diff-model.js:154-155`), and either:
- `section.isBinary` (any binary file: the ops then say `not-image` for non-images, and the view
  falls back to today's message), or
- the path has an image extension from the catalogue (SVG, LFS pointers, `.png` with `-binary`
  attributes) and the section is text. Then the view shows a **Preview | Text** toggle (I3).
  Before I3, text diffs stay as they are.

Multi-section diffs (type changes, `sections.length > 1`) keep the current rows.

### 6.2 View (`renderer/components/image-preview.js`, `window.PLImagePreview`)

Built like `PLDiffStaging.create(...)` (`diff-view.js:149-151`): a sub-view the diff view owns.
`layoutBody` (`diff-view.js:370-410`) inserts its root in place of the binary message
(`:389-391`). It subscribes to the `imagePreview` key itself, so a landing side redraws only the
preview, not the virtualized rows.

```
┌ header (existing): path · badges [image · WebP · animated] · Δ +12.4 KB (+8.1%) · [Fit|100%] · × ┐
│ ┌──────── Before ──────────────┐ ┌──────── After ───────────────┐                                 │
│ │ ░▒░▒ checkerboard ░▒░▒        │ │ ░▒░▒                          │                                 │
│ │        <img>                  │ │        <img>                  │                                 │
│ └───────────────────────────────┘ └───────────────────────────────┘                                │
│  WebP · 512×512 · 148.2 KB         WebP · 512×512 · 160.6 KB · content is PNG (ext .webp)          │
└────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Panes**: Before = `old`, After = `new`. An added file shows only After, labelled "Added"; a
  deleted file only Before, "Deleted". A pane with a non-image state shows its message in the pane
  (below). Both panes share one zoom; at 100% their scroll positions are synced.
- **Metadata**: format label (`FORMATS[id].label`, "animated" when known), decoded W×H, size
  (`formatBytes`: B / KB / MB, 1 decimal, 1 KB = 1,024 B like Finder's "KiB" convention, Q8),
  source for workdir diffs ("Index", "Working copy", "HEAD"), and the mismatch note. Header delta:
  size Δ and %, "dimensions changed 512×512 → 1024×1024", "format changed PNG → WebP".
- **Zoom**: `Fit` (scale = min(1, pane / natural): never enlarges, so icons stay crisp at 1×) and
  `100%`. I3 adds zoom in / out (×2 / ÷2, 12.5%–3200%). Above 100%: `image-rendering: pixelated`.
  `devicePixelRatio` is respected: 100% = one image pixel per CSS pixel.
- **Checkerboard** behind every image: `repeating-conic-gradient(var(--checker-a) 0 25%,
  var(--checker-b) 0 50%) 0 0 / 16px 16px`. The two new tokens go in `renderer/style.css` `:root`,
  so the light theme planned in roadmap P6 (line 180: dark only today) just redefines them.
  Everything else uses existing tokens (`--panel`, `--text-2`, `--border`, `--green` / `--red` for
  deltas).
- **States per pane** (text, `textContent` only):
  - loading: "Loading image…" (after 150 ms, so fast loads don't flash)
  - `absent`: "Added" / "Deleted" (no pane)
  - `too-large` soft: "Large image (34.2 MB)" + **Load preview** (re-runs with `force`)
  - `too-large` hard / pixels: "Too large to preview (82 MB, 12,000×9,000)"
  - `lfs-pointer`: "Stored in Git LFS (2.4 MB) — not loaded"
  - `unsupported`: "HEIC — preview not supported"
  - `not-image` on both sides: the old message, `Binary file — no preview` (no panes)
  - decode error (`img` `error` event): "Couldn't decode this image"; both sides failing → the
    binary message plus the sniffed format
  - op error: the error message, as the diff view shows `d.error`
- **Header badges** (`diff-view.js:177-199`): `binary` becomes `image` for a previewable file (Q9).
  The staging note "Binary file — stage it as a whole…" (`diff-model.js:193`) stays.
- **Accessibility**: each `<img>` gets `alt` = "Before: <name> (WebP, 512×512)". The pane group is
  `role="group"` with `aria-label`. The zoom buttons are real `<button>`s with titles, and the
  scroller stays focusable so arrows and PgUp / PgDn pan the panes.
- **Untrusted content**: path and labels go through `textContent`. The only URLs ever set on `src`
  are `blob:` URLs this page created.

### 6.3 Store (`renderer/store.js`)

- New key `imagePreview: null | ImagePreview` (§2.2), documented in the header contract
  (`store.js:44-90`), reset with the repo (`store.js:286`) and set to null whenever `diff` becomes
  null (close, select, rebase editor).
- `loadImagePreview(spec, {force?, side?})`: called by the store itself after a diff lands
  (`loadDiff`, `store.js:702-707`) when `PLImage.wantsPreview(spec, data)`, and on reload with each
  side's `knownKey`. The fetch is `commitImageSide` / `workdirImageSide`, mirroring `fetchDiff`
  (`store.js:681-685`), with an opId per side (§5.6).
- On landing: `PLImageCache.put(key, bytes, mime)` → `url`. The `ImageSide` is stored **without**
  `bytes`.
- Watcher refreshes reuse `diffNeedsReload` (`store.js:483`): the diff reload is followed by a
  preview reload with `knownKey`. Unchanged sides keep their `url`, so nothing flickers.

### 6.4 Object-URL cache (`renderer/image-cache.js`, `window.PLImageCache`)

- An LRU keyed by `RevisionKey`, at most 24 entries and a 256 MB byte budget. `put` creates
  `URL.createObjectURL(new Blob([bytes], {type: mime}))`. Eviction calls `URL.revokeObjectURL`.
- `pin(keys)` / `unpin`: the keys on screen are never evicted.
- `clear()` on repo switch and when the diff view unmounts.
- `URL` is injected (`create(urlApi)`) so `test/` can count create / revoke calls without a DOM.
- A git oid key is immutable, so switching back and forth between files or commits never refetches.
  A worktree key (`wt:dev:ino:size:mtimeNs`) changes on every save.

### 6.5 Comparison modes (I3)

Shown only when both sides are `image`:
- **Swipe**: both images stacked at the same scale (the larger dimensions win, top-left aligned),
  with a draggable divider; the keyboard moves it 5% per arrow.
- **Onion skin**: the After image over Before, with an opacity slider (0–100%).
- **Difference**: After with `mix-blend-mode: difference` over Before; identical pixels go black.
  Pure CSS, no pixel loops.

The mode is remembered per session (`localStorage`, like the pull mode: roadmap §1.10), wrapped in
try/catch.

### 6.6 Keys (I3)

New `KEYS` entries (`renderer/keys.js`), active only while an image preview is shown: `+` / `-`
zoom, `0` Fit, `1` 100%, `m` cycle mode. They must not collide with the diff view's `n` / `p`
(`diff-view.js:493-496`) or global keys. I3 checks the full `KEYS` table, and
`test/keys.test.js` covers it.

### 6.7 As built (I2)

What I2 actually ships, where it differs from or pins down §6.1–§6.4 and §11.2. I3 builds on this.

**Files.** `renderer/image-cache.js` (`PLImageCache`), `renderer/components/image-model.js`
(`PLImage`, pure), `renderer/components/image-preview.js` (`PLImagePreview.create({store})`, the
view), `renderer/components/image-preview.css`; edited `renderer/store.js`,
`renderer/components/diff-view.js`, `renderer/index.html` (CSP, scripts, stylesheet),
`renderer/style.css` (`--checker-a`, `--checker-b`), `renderer/components/diff-view.css` (the `image`
badge), `eslint.config.js`, `test/renderer-harness.js`. Tests: `test/image-model.test.js`,
`test/image-cache.test.js`, `test/image-preview-ui.test.js` (the mounted diff view on the fake DOM,
the CSP and the script order), and new cases in `test/store.test.js` and `test/diff-view.test.js`.

**`blob:` from the `file://` page: verified in the real app.** A `--smoke` run (Electron 44.4.5,
Chrome 152) with a `PL_SMOKE_JS` script: under the old CSP an `<img>` with a `blob:` URL fails to
load (a `data:` URL loads); with `img-src 'self' data: blob:` the PNG and an SVG load, the URLs are
`blob:file:///<uuid>`, and the SVG's `<script>` and `onload` do not run (the page title is
unchanged). So no `data:` fallback was built; it would be a one-line change in `PLImageCache.put`.

**Script order.** `../src/image-format.js` follows `../src/error-kinds.js`; `image-cache.js` and
`components/image-model.js` load **before `store.js`** (the store uses `PLImage.wantsPreview` /
`sameTarget` and owns the cache), like `components/rebase-model.js`. Only the view,
`components/image-preview.js`, loads just before `components/diff-view.js`. The harness loads the
first three in `loadRenderer` (not `loadComponentHelpers`), so every store test has them.

**Store.**
- `state.imagePreview = {spec, old: Slot, new: Slot}`: the open diff's spec itself (not a
  `specKey`); `PLImage.sameTarget` (kind, file, staged, sha, as `PLDiff.sameSpec`) decides "the same
  file". `Store.create(api, {urlApi})`: the URL api is injectable for the tests.
- **Dropping is in `set()`**: whenever `diff` changes to null or to another file, `set()` cancels
  the reads in flight (`app.cancel` per op id), bumps the preview generation, unpins the cache and
  sets `imagePreview` to null in the same notification, instead of patching every place that sets
  `diff: null` (close, select, the rebase editor, a refresh, a repo switch).
- `loadDiff` calls `previewFor(spec, data)` **before** the diff lands, so the body that shows the
  preview renders with its loading slots in place. It runs on **every** fetch, a reload included,
  even when the diff data is unchanged: a binary diff's text ("Binary files … differ") is the same
  whatever the bytes are, so the preview can't ride on the diff's change detection. The `knownKey`
  of each side keeps that cheap: an unchanged side is one `ls-tree` / `ls-files` / `fstat` and sets
  nothing.
- Per side: a generation (a newer read wins) and the op id of the running read (cancelled when a
  newer one starts). `aborted` never lands; `stale` on a side already shown keeps it (the watcher's
  reload follows); any other error is the slot's `error`. An `unchanged` reply for a key the slot no
  longer holds re-reads the side without `knownKey`.
- `loadImagePreview(spec, {force, side})` is also the Load preview action: `force` with one `side`
  re-reads only that side (shown as loading meanwhile). `releaseImagePreview()` (the diff view
  unmounting) also empties the URL cache; `loadRepo` empties it too. Closing the preview is the
  store's own (no `closeImagePreview` action; §2.1 listed one).

**Cache.** As §6.4, plus: `put` never evicts the key it just put (with both slots pinned and the
cache at its limit it would otherwise revoke the URL it returns), and `pin` runs the eviction too.

**View.**
- **The delta and Fit | 100% are in a summary bar at the top of the preview**, not in the diff
  header: the header is rebuilt with every diff render, while zoom and decoded sizes are the
  preview's own state, and a side landing must redraw only the preview. The header only swaps its
  badge in place (`PLImage.badge`: `image` by the file's extension while loading, then by content:
  any side with a format, tier 2 included, or an LFS pointer; else `binary`; Q9).
- The summary bar, the pane row, each pane and each `<img>` are made once per file and updated in
  place, so a side landing doesn't move focus or reset a pane's scroll (a test checks it). A pane's
  message is made again only when it says something else, so a focused Load preview button keeps
  focus and "Loading image…" its delay while the other side lands. A render drops the `<img>`s (and
  decode results) of URLs no slot shows any more: a working-copy image saved while it is open gets a
  new key, so a new URL, with every save.
- Fit is computed (`PLImage.scaledSize`) from the stage's size and `naturalWidth` / `naturalHeight`
  after the `load` event (a `ResizeObserver` on the preview re-fits), not with CSS `max-width`: an
  image is hidden (`visibility`) until it has its size, so a large one never flashes at 100%.
- "Loading image…" appears after 150 ms through a CSS animation delay, not a timer.
- The size change is coloured like the diff stats (larger green, smaller red).
- The intent-to-add old side (`not-image`, size 0, source `index`) counts as absent: one "Added"
  pane (`PLImage.isAbsent`). An emptied new side says "Empty file".
- A `not-image` side next to an image says "Not an image — no preview"; a `special` one "Not a
  regular file — no preview". When neither side has anything to show (a binary non-image, both
  decodes failed) the binary message stays, plus "Couldn't decode this PNG" after a decode failure.
- Chromium decodes a **truncated** PNG partially and fires `load`, so it shows the rows it has; only
  undecodable data fires `error` ("Couldn't decode this image"). Both were checked in the real app.
- Not in I2 (I3): zoom steps, `image-rendering: pixelated` above 100%, keyboard shortcuts, the
  comparison modes, text-backed previews (`wantsPreview` is binary-only), conflicts.

**Themes.** The app has only its dark theme (`renderer/style.css`); the checkerboard uses the two new
`:root` tokens, which a light theme only has to redefine.

**Runtime checks** (`--smoke` with `PL_SMOKE_JS` on a scratch repository, git 2.51.2, macOS 15):
an unstaged PNG (index vs working copy), a commit's WebP (dimensions and size changed), an untracked
and an added WebP ("Added"), an SVG with `<script>` / `onload` marked `binary` (renders, runs
nothing), a `.png` holding JPEG bytes (mismatch note), a HEIC ("HEIC — preview not supported"), a
binary non-image (the binary message, `binary` badge), a 25.8 MB PNG ("Large image" + Load preview,
then 3,000×3,000 at Fit), a truncated and an undecodable PNG. The checkerboard and Fit / 100% sizes
were read back with `getComputedStyle` / `getBoundingClientRect`. The window capture failed in that
session (no display surface), so there is no screenshot yet: the PR's screenshot and
`docs/screenshots/image-diff.png` are still to do.

### 6.8 As built (I3)

What I3 actually ships, where it differs from or pins down §4.1, §4.4, §6.1, §6.2 and §6.5–§6.6.
Decided for I3 (§13): an SVG with a text diff opens as the rendered **Preview** (Q4, not text first);
Git LFS from the local cache only (Q3); the comparison modes are in (Q5); conflicted binary images
are handled here (Q10); `.svgz` stays unsupported (Q6) and sizes stay in binary units (Q8).

**Commits.** `feat(preview): local Git LFS objects and conflict stages` (backend),
`feat(renderer): image comparison modes, zoom steps, keys, text-backed and conflicted images`,
`test(smoke): demo-repo images and an image preview smoke run`, and this section.

**Git LFS (backend).**
- `blobRevisions.lfsRevision(repo, side, {oid, size})` looks the object up at
  `<git common dir>/lfs/objects/<oid[0:2]>/<oid[2:4]>/<oid>` (`repoDirs().commonDir`, so a linked
  worktree and a bare repository find it too) with `lstat`: only a regular file of exactly the
  pointer's size counts (a link is not followed, a custom `lfs.storage` is not looked at). It is
  read like a worktree file (`O_NOFOLLOW`, the stat key checked again on the open handle) and
  `readRevision` returns null when its sha256 isn't the oid: the side then stays `lfs-pointer`.
- `ops.previewSide` judges the pointer first; for an `lfs-pointer` side it asks the cache and judges
  the object instead (source `'lfs-cache'`, the pointer's `lfs: {oid, size}` attached, so the pane's
  metadata says `LFS <oid>`). Its RevisionKey is `lfs:<sha256>`, which differs from the side's
  resolved key (the pointer blob's oid), so a `knownKey` of an LFS object is compared **after** the
  pointer is read (at most 1 KiB) and before the object is.
- An object over the soft cap is not read at all, like a git blob (its hash can't be checked from a
  head): `too-large` by the file name's extension, with `lfs`; Load preview (`force`) reads it.
- A pointer whose object isn't there says "Stored in Git LFS (2.4 MB) — not available locally"
  (I2: "— not loaded"). The store never sends its key as `knownKey`, so every reload reads the
  pointer again (one small `cat-file` and an `lstat`) and an object downloaded meanwhile shows up.
- Nothing but `ls-tree`, `ls-files`, `cat-file` and file reads ever runs: a test records every git
  argument list and finds no `lfs`, `filter-process` or `smudge`. git-lfs isn't installed on the
  machine this was built on; no network-off run was done (the read path makes no network calls).

**Conflicts (backend).**
- `resolveSide` asks the index for every stage of a working-copy path (not untracked) first; an
  unmerged one resolves `old` to stage 2 (ours), `new` to stage 3 (theirs) and the new side
  `'base'` to stage 1, whatever `staged` says; a missing stage is `absent` (modify/delete, add/add).
  Side `'base'` of anything else is `absent`; `workdirImageSide` accepts it, `commitImageSide`
  refuses it (`invalid-args`). So `workdirImageSide` no longer fails with `conflict` (`indexEntry`
  still throws it for hunks.js).
- `src/diff-view.js` flags a combined diff that says "Binary files differ" (and has no hunks) with
  `conflict.isBinary: true` (git 2.51 prints `diff --cc a.png`, `index …`, `Binary files differ`).

**When a diff gets a preview.** `PLImage.previewKind(spec, data)` → `'binary'`, `'text'`,
`'conflict'` or null; `wantsPreview` is `previewKind !== null`.
- `'text'`: exactly one section, with hunks (a rename or mode change without content changes keeps
  its message), not binary, whose path (or rename source) has a catalogue image extension: an SVG,
  and a Git LFS pointer of any image type.
- `'conflict'`: `conflict.isBinary`, or a conflict without a combined diff (modify/delete: "* Unmerged
  path") of a file with an image extension. A text conflict of an SVG keeps its combined diff.

**Preview | Text.** In the diff header (not the preview's summary bar: it must stay when the text is
shown), for `'text'` only; Preview by default. The choice is one preference for the app in
`localStorage` (`pl.imageView`, through `Components.util.storage`, like the panel widths and the pull
mode), so it outlives the session (§6.5 said "per session (localStorage …)"; localStorage is what the
app's other view preferences use). Switching keeps focus on the switch. The view tells the store the
choice (`setImageView('preview' | 'text')`, when it mounts and on each switch): while Text is shown
the store reads no side of a text-backed image, choosing Preview loads both at once (its slots are in
place before the body renders), and a preview already loaded stays and reloads with its keys. A
text-backed diff has no
`image` badge (that badge replaces `binary`). When neither side has a picture the preview says "No
image to preview — Text shows the change".

**Conflicted images.** `state.imagePreview` gains `conflict` and, for a conflict, a third slot `base`
(`SIDES`, `sideGen`, `inflight`, pinning and cancelling cover it). The store's private
`startPreview(spec, data)` takes the diff about to land, because the store starts the preview before
the diff lands (`loadImagePreview` runs it with the diff shown); a file that becomes or stops being a
conflict starts over. The panes are **Base | Ours (main) | Theirs (feature/x)**, the names from `PLOp.conflictSides` (during a rebase ours is the new base, theirs the
replayed commit), plain "Ours" / "Theirs" when no merge or rebase is in progress; no Base pane
without a stage 1; a missing stage says "Deleted on this side". Titles are neutral (no before /
after colours), no size delta, no comparison modes, no "Index" source in the metadata. The banner
reads "Conflicted image — the base, ours and theirs versions. Keep one side or mark the file
resolved in the WIP panel."

**Comparison modes.** A segmented control in the summary bar (Side by side | Swipe | Onion skin |
Difference; like Preview | Text and the zoom group, a `.seg` group of `.seg-btn` buttons from
`style.css`, made with `Components.util.button`), shown only when `PLImage.canCompare`: both sides `image`, both URLs, neither failed, not
a conflict. The mode is one preference for the app (`pl.imageMode`); a stored mode that can't apply
(an added file, a decode failure) shows side by side.
- One frame (`.ip-frame`) of the larger width and height at one scale (`PLImage.overlaySize`; Fit
  fits the frame), both images absolutely positioned at its top-left. The frame carries the
  checkerboard (the images none) and `isolation: isolate`.
- Swipe: Before left of the divider, After right of it (`clip-path: inset(0 0 0 <px>)` on After).
  The divider is a `role="slider"` element: drag anywhere on the frame (pointer capture), or focus
  it and use ←/→ (also ↓/↑), 5% a step, Home / End.
- Onion skin: After's opacity from an `<input type="range">` (After opacity, 50% at first).
- Difference: After with `mix-blend-mode: difference` over Before on a black frame.
- The same two `<img>` elements move between the panes and the frame, so switching modes never
  reloads an image; the swipe and opacity positions stay from file to file (not stored).

**Zoom.** − / + buttons around Fit | 100% and a level readout (`PLImage.zoomStep`, `ZOOM_STEPS`
12.5%–3200%): from Fit, a step starts at the scale of the most shrunk image on screen (Fit of a
small image is 100%). With no step that way, a step changes nothing: − at Fit below 12.5% (a huge
image) stays at Fit, it doesn't zoom in to 12.5%. Above 100% `.ip.is-pixelated` sets
`image-rendering: pixelated` (Fit never enlarges, so only a number zoom gets there). A resize
re-fits the images and updates − / + (at Fit the scale moves). The level readout is an `aria-live`
region only for a zoom the user asked for (`polite`; `off` for a resize or a redraw) and is written
only when its text changes, so resizing the window announces nothing. The panes scroll together at
every number zoom (I2: at 100%). Scroll events come a frame after the write, so a mirrored pane fires
one too: the view records the position its write left that pane at (clamped when its image is
smaller) and doesn't mirror that event back, which would pull the pane being scrolled into the
smaller one's range.

**Keys.** §6.6 asked for `KEYS` entries, but `KEYS` is the ⌘ / Ctrl table (`matchKey` needs the
modifier) and ⌘+ / ⌘- / ⌘0 are the View menu's page zoom. So `keys.js` has a second frozen table,
`VIEW_KEYS` (`matchViewKey(e, view)`, `viewKeyHint(id)`), of single keys with no ⌘ / Ctrl / Alt: the
image preview's `+` (and `=`) zoom in, `-` (and `_`) zoom out, `0` Fit, `1` 100%, `m` next mode, and
the diff view's existing `n` / `p` / `s` / `u` / Esc, which diff-view.js and diff-staging.js now
match through it. `test/keys.test.js` checks that no key is in two entries (the image keys run inside
the diff view) and that none is the graph's. Like `n` / `p`, they act while the diff view shows a
preview with a picture (the zoom group visible), from the document, not only while a pane has focus
(§12 said "while a preview has focus"); never in a text field or with a dialog open. `m` ignores key
repeats; the zoom keys repeat.

**Demo repository and smoke run.** `scripts/demo-repo.js` gains `images/` from small files in
`test/fixtures/images` (11 files, 12 KB; made once with ImageMagick 7, ffmpeg + SVT-AV1 and macOS
`sips`; a test checks each sniffs as named). `big.avif` became `badge.avif` (64×64, it isn't big).
The two LFS pointers come without `.gitattributes`, so a git-lfs in the user's own config never runs
filters on the demo, and `lfs-cached.png`'s object is written into `.git/lfs/objects`. There is no
conflict in the demo (it would put the whole repository in a merge); the smoke run makes its own.
The smoke script is `scripts/smoke-image-preview.js` (Node: builds the demo and a conflicted merge
in a temp folder, runs `--smoke` on each, exit 0 / 1) with the page script
`scripts/smoke/image-preview.page.js`, not a change to `main/smoke.js`; `eslint.config.js` lints
`scripts/smoke/` as a browser script. Two things about the smoke window: it is shown transparent and
inactive, so Chromium clamps its timers to a second (the page script waits by MessageChannel ticks),
and `img.decode()` never settles there (the script waits for `complete` and checks `naturalWidth`).

**Tests.** `test/image-preview.test.js` (conflict stages, missing stages, side `base`, the LFS cache:
found, knownKey without reading the object, missing / corrupt / resized / linked, the soft cap, a
linked worktree and a bare repository, no `git lfs`), `test/diff-view-backend.test.js` (`isBinary`),
`test/image-model.test.js` (`previewKind`, conflict layout, zoom steps, modes, `overlaySize`),
`test/store.test.js` (three sides of a conflict, cancelling them, an SVG text diff, the LFS pointer
key, no side read while Text is shown), `test/image-preview-ui.test.js` (zoom buttons, keys, the
modes, Preview | Text and its persistence, a conflict's panes, scroll mirroring with stages that clamp
and fire their scroll events a frame later, a focused Load preview button across a redraw, a resize
at Fit; each test installs its own fake DOM and layout stubs, so any one runs alone),
`test/keys.test.js` (`VIEW_KEYS`), `test/image-format.test.js` (the fixtures). The harness's
component DOM gained document fragments (diff rows under test) and selector lists (`'a, b'`).

**Runtime checks** (`node scripts/smoke-image-preview.js`, Electron 44.4.5 / Chrome 152, git
2.51.2, macOS 15, passing): the unstaged animated WebP (both sides decoded, the size change); the
commit's PNG with `+ +` (400%, 256 px, computed `image-rendering: pixelated`), `0`, and `m` through
the modes (computed `clip-path: inset(0px 0px 0px 32px)`, opacity 0.5, `mix-blend-mode: difference`,
a 64×64 frame), a pointer drag of the divider to 25%; the SVG text diff (rendered first, Text shows 7
rows, back to Preview); `lfs-cached.png` decoded from the local cache (`LFS 860aef726c`) and
`lfs-missing.png` "not available locally"; HEIC "preview not supported"; the EXIF-rotated JPEG at
40×80; the mislabeled PNG's note; the animated GIF; the AVIF; and in the conflicted merge Base /
Ours (main) / Theirs (other) with three decoded images. The window capture still fails in this
environment (`UnknownVizError`), so there is no screenshot: `node scripts/smoke-image-preview.js
docs/screenshots/image-diff.png` makes one where capture works.

**For I4.** The hook is `ops.previewSide`: like the LFS lookup after the first `judge`, an
`unsupported` tier 2 side (HEIC, TIFF, PSD) can be handed to the OS thumbnailer and judged again as
a PNG (`source: 'os-thumbnail'`, its own RevisionKey compared to `knownKey` after the original is
resolved). A tier 2 git side over the soft cap is never read and comes back `too-large`, not
`unsupported`. The renderer needs only a label for the new source (`PLImage.meta`'s `SOURCES`, e.g.
"Preview by macOS"); comparison modes size from the decoded `naturalWidth` / `naturalHeight`, so a
scaled thumbnail compares as it is. `test/fixtures/images/scan.heic` (64×64, from `sips`) is in the
demo, and the smoke page script's `scan.heic` check expects "HEIC — preview not supported": I4
changes that check.

---

## 7. Tier 2 formats (I4, gated by Q2)

### 7.1 Options compared

| Option | HEIC | TIFF | PSD | Packaging cost | Notes |
|---|---|---|---|---|---|
| **A. OS thumbnailer**: write the blob to a 0600 temp file in an app-private temp folder, `nativeImage.createThumbnailFromPath(path, {width, height})` in main, `toPNG()` → returned as a PNG `ImageSide` | macOS (QuickLook) ✔; Windows: only with the HEIF / HEVC extensions installed | ✔ | ✔ macOS (QuickLook); Windows depends on installed handlers | **None**: Electron API, macOS + Windows only, nothing on Linux | A scaled preview (we pick up to 2,048 px), not pixel-exact: labelled "Preview by macOS". The temp file is deleted in `finally`. Untrusted bytes go to the OS's QuickLook generators, the same exposure as Finder showing the file |
| **B. JS / WASM decoders in a `worker_thread` in main**, output PNG (encoded with Node's `zlib`) | `heic-decode` 2.1.0 (ISC, 2025-07-04) on `libheif-js` 1.23.5 (**LGPL-3.0**, released 2026-10-04, ~9 MB unpacked, an Emscripten build of libheif + libde265) | `utif2` 4.1.0 (MIT, last release 2023-05-06, ~100 KB, `pako` dep) | `ag-psd` 31.0.3 (MIT, released 2026-10-07; composite image only, needs "Maximize compatibility" saves) | The first runtime `dependencies`: `build.files` must add their `node_modules` paths; ~+10–12 MB per DMG; no native code, so no rebuilds and nothing per-arch | Decoding in main's worker keeps the renderer CSP free of `'wasm-unsafe-eval'`. LGPL: ship `libheif-js` unmodified and list it in `NOTICE`. **HEVC patents**: a legal question for whoever distributes (Q2) |
| **C. `sharp`** 0.35.5 (Apache-2.0, released 2026-09-27; prebuilt libvips 1.3.4) | **✘** prebuilt binaries read HEIF only as AVIF. HEVC-compressed HEIC needs "a globally-installed libvips compiled with support for libheif, libde265 and x265" (sharp docs) | ✔ | ✘ (libvips doesn't read PSD) | High: a native `.node` + `@img/sharp-libvips-darwin-*` (~18 MB unpacked each); `asarUnpack` for `sharp/**` and `@img/**` (sharp docs, electron-builder section); the x64 DMG built on arm64 needs the x64 `@img` packages installed explicitly (npm installs only the host's optional deps); every `.dylib` signed and notarized under the hardened runtime; contradicts CONTRIBUTING.md:166-170 | Gains only TIFF over Chromium. **Not recommended** |

### 7.2 Recommendation

**Don't ship Tier 2 in v1.** Show `unsupported` with the format name (better than today's generic
binary message). If HEIC / TIFF / PSD matter (Q2), build **option A** first: S size, zero
dependencies, covers macOS, the only platform the app is built and tested on today (CONTRIBUTING.md
"Requirements"). Option B only if Linux or pixel-exact decoding matters.

### 7.3 As built (I4)

Q2 was decided for **option A**: HEIC, TIFF and PSD through the OS thumbnailer, no dependency, no
decoder in the app. What I4 ships, where it differs from or pins down §7.1 and §11.4.

**Commits.** `feat(preview): HEIC, TIFF and PSD through the OS thumbnailer` (backend),
`feat(renderer): say when an image is the system's preview`, `test(smoke): TIFF and PSD in the demo
repository, thumbnails in the smoke run`, and this section.

**The Electron call, as checked** (the Electron docs through Context7, then a probe app on Electron
44.4.5, macOS 15.7, with HEIC / TIFF / PSD files from `sips` and ImageMagick):
- `nativeImage.createThumbnailFromPath(path, size)` → `Promise<NativeImage>`, macOS and Windows
  only; Windows ignores `size.height`; since Electron 24 the docs say the thumbnail is scaled to the
  size asked for.
- On macOS `getSize()` does report the size asked for, but `toPNG()` holds QuickLook's bitmap, which
  is **never larger than the image** and up to **twice** the size asked for on a Retina screen (a
  6,000×4,000 HEIC asked at 1,024×683 gave a 2,048×1,366 PNG; a 64×64 one asked at 2,048 gave
  64×64). So the PNG's own IHDR is what counts, never `getSize()`.
- A missing file rejects ("unable to retrieve thumbnail preview image for the given path"). A file
  QuickLook can't read **doesn't**: it resolves with the file type's **icon** (a square "HEIC" /
  "TIFF" document picture, 1,024×1,024 or smaller). Asking 2,048×1,365 of a 3,000×2,000 TIFF also gave
  the icon, while 1,024×683 gave the picture.
- Timing: 10–120 ms per call, plus `toPNG()` on the main thread (about 90 ms for 2,048×1,365; the
  event loop stalled up to ~90 ms for the largest). One call per side, bounded by the size asked for.
- **Windows: not used** (after the I4 review). Electron 44.4.5's Windows implementation
  (`shell/common/api/electron_api_native_image_win.cc`, read on GitHub at `v44.4.5`) calls
  `IThumbnailCache::GetThumbnail` synchronously on the calling thread, main's, and only then
  resolves the promise; so a slow or hung Shell thumbnail handler would freeze the app, and no
  timeout could fire. It also keeps the thumbnail in the system's thumbnail cache. The macOS one
  (`electron_api_native_image_mac.mm`) asks `QLThumbnailGenerator` asynchronously. So the
  thumbnailer is macOS only.
- QuickLook applies a HEIC's `irot` and a TIFF's Orientation: a 96×64 HEIC with `irot` 1 and a
  96×64 TIFF with Orientation 6 come back 64×96 (`qlmanage -t` and the smoke run).

**Port and adapter.** `src/os-thumbnail.js` has no Electron in it: `createOsThumbnailer({thumbnail,
platform})` → `{by, render, idle, busy, sweep}`, or **null** on any platform but `darwin` (or without
a call; I4 also had `win32`, see above). `main.js`, the composition root, passes `thumbnail(file, size)` = the Electron call, `null`
for an empty image, else `toPNG()`, and hands the thumbnailer to `ops.createRunner({thumbnailer})`,
which builds the two image ops with it (`imageOps(thumbnailer)` in `src/ops.js`). `ops.OPS` and a
runner without one (every test that doesn't ask for it, plain Node) read as before. Not a module
setter like `exec.setGitBinary`: the port is per runner and needs no global to reset in tests.

**`render(bytes, {format, dims, signal})`** → `{png, width, height}` or null:
- Only `heic`, `tiff` and `psd` (`imagePreview.THUMBNAIL_FORMATS`; `.svgz` and JPEG XL stay
  unsupported, Q6 / Q7), and only with header dimensions (else nothing is asked).
- **A private temp copy, always**, even for a worktree file: the bytes already read and checked for
  the side go to a new `mkdtemp` folder (0700) as `image.<the sniffed format's extension>` (0600,
  created exclusively). The hand-off allowed thumbnailing a worktree file in place; the copy was
  chosen instead because the OS picks its decoder by the extension (a `.png` holding a HEIC would
  fail in place), the bytes shown are the bytes whose stat key was checked (no window for a save or
  a swapped folder between the check and QuickLook's open), and the user's file is never handed
  over. The cost is one write of at most the side's size (≤ 20 MB, 50 MB with Load preview).
- Size asked: the header's dimensions fitted into **1,024** px, never enlarged (macOS answers up to
  2,048 on a Retina screen; 2,048 asked could give the icon, see above).
- **The answer check**: a PNG, no larger than the header's dimensions, of their aspect ratio within
  ±1 px, in either orientation (after the review: the header's dimensions are the displayed ones,
  see **Format**, and a turn they don't know of may still come back turned). That refuses the icon
  of any non-square image, an upscaled answer and anything not a PNG. A refused, empty or failed
  answer is null.
- The folder is removed when the OS call ends, whatever happened (`finally` on the call, not on the
  op). `idle()` resolves when every call has ended and its folder is gone (the tests wait on it);
  `busy()` says a call hasn't. Quitting (`before-quit` in main.js, after the reads are cancelled)
  waits for `idle()` at most 2 s, then quits again; at startup `sweep()` removes `pasta-lite-thumb-*`
  folders directly in the temp folder that are over an hour old and owned by this user (an earlier
  run died while the OS worked), never through a link.
- **Cancellation**: an aborted signal rejects kind `aborted` at once, before the copy is made, while
  waiting for a slot, or while the OS works (that call can't be stopped; its folder goes when it
  ends). **At most 2 OS calls** run at once, a cancelled one counting until it ends or its deadline
  passes, so j/k through commits can't pile up QuickLook work; a call cancelled while it waits never
  reaches the OS.
- **Timeout** 20 s over waiting for a slot and the OS call together (I4: the OS call only, so a
  call waiting behind two hung ones waited forever): null (the side stays unsupported), the folder
  removed when the call ends. A call still running at its deadline is **abandoned**: it no longer
  holds its slot, so hung QuickLook calls don't block every later thumbnail; while 4 abandoned calls
  hang, nothing new is handed to the OS (null at once) until one ends. §5.6 said "no timeout: reads
  are cancellable", but an OS call that never answers would leave the pane loading until the user
  moves on.

**Ops** (`ops.previewSide`). With a thumbnailer, `imageSide(..., {thumbnails: true})` caps HEIC,
TIFF and PSD like tier 1: over the soft cap a git side isn't read (`too-large` by the extension), a
worktree side reads its head (`too-large` with the format), and Load preview (`force`) reads it
whole; under the caps the side is `unsupported` with all its bytes, and `render` gets them. A PNG
answer becomes `imagePreview.thumbnailSide(s, thumb, by)`: kind `image`, source `'os-thumbnail'`,
`mime: 'image/png'`, the PNG's bytes, key `os:<the original's key>` (`thumbnailKey`), `animated:
false`, and `thumbnail: {by: 'macOS', from: <the original's source>, width, height}`;
`format`, `size`, `dims`, `mismatch` (and `lfs` for an LFS object) stay the original's. **No pixel
cap** for these: the bitmap the page decodes is at most 2,048 px, and the OS scales the original.
`knownKey` is compared with both the side's key and its `os:` key right after resolving, so a reload
reads nothing and doesn't ask the OS again; for a Git LFS object after the pointer, as in I3. A
failed thumbnail leaves the side `unsupported` keyed as the original, so reloads don't ask the OS
again until the file changes.

**Format.** `dimensions(bytes, 'tiff')` reads ImageWidth / ImageLength from the first IFD (the first
page; II / MM, BigTIFF, SHORT / LONG / LONG8), bounds-checked like the other parsers. I1 had null for
TIFF; the answer check needs dimensions. After the review the dimensions are the **displayed** ones:
TIFF Orientation (274) 5–8 swaps them, and HEIF / AVIF take the primary item's `ispe` (`pitm` and its
`ipma` associations, no longer the largest extent: sips writes 128×64 tiles for a 64×96 picture) turned
by its `irot` (1 or 3 quarter turns swap them). An iPhone's portrait HEIC is stored landscape, so I4
asked QuickLook for a landscape size and refused its portrait answer: the side stayed unsupported.
Without `pitm` / `ipma` the largest extent and any `irot` count; a head read cut before the primary's
properties or the Orientation is null (unknown), never a maybe-unturned size. The sniff is bounded on
crafted files too: the AVIF animation check reads the brands of the sniffed head only (the `ftyp` size
is the file's), and the APNG check walks at most 10,000 chunks.

**Renderer** (`PLImage`). A thumbnail's pane shows the original's format, dimensions and size, then
"Preview by macOS" (`thumbnail.by`; no other thumbnailer exists now), with ", scaled to
2,048×1,366" when the thumbnail is smaller than the original (`thumbnailText`); the "Index" /
"Working copy" source is the original's (`thumbnail.from`).
`dimsOf` prefers the header's dimensions for a thumbnail, so the delta and the alt text compare the
originals. Comparison modes, the badge and zoom need no change: the modes size from the decoded
thumbnail; 100% is one thumbnail pixel per CSS pixel (the label says when it is scaled).

**Demo and smoke run.** `test/fixtures/images` gains `scan.tiff` (96×64, two pages: an orange to purple
gradient, then teal) and `layers.psd` (64×64, two layers), made with ImageMagick 7; the demo commits
them next to `scan.heic`. After the review it also gains `portrait.heic` (a sips HEIC of 96×64 whose
`irot` angle was set to 1 by hand) and `portrait.tiff` (96×64, ImageMagick's `-orient RightTop`:
Orientation 6), both shown 64×96. The smoke page script expects a decoded thumbnail labelled "Preview
by macOS" with the original's displayed dimensions for all five on macOS, and "preview not supported"
elsewhere (Windows included); on macOS it reads a pixel of the TIFF's thumbnail through a canvas to
check it is the first page.

**Runtime checks** (`node scripts/smoke-image-preview.js`, Electron 44.4.5 / Chrome 152, git 2.51.2,
macOS 15.7, passing): `scan.heic` 64×64, `scan.tiff` 96×64 (first page: pixel 252,161,4), `layers.psd`
64×64, each "… · Preview by macOS". An extra `--smoke` run on a scratch repository: a 6,000×4,000 HEIC
(3.4 MB) → 2,048×1,366, "HEIC · 6,000×4,000 · 3.4 MB · Preview by macOS, scaled to 2,048×1,366", the
side in 685 ms; a 34.3 MB TIFF → "Large image (34.3 MB)", then Load preview → 2,048×1,365; a HEIC cut
to a third → QuickLook's partial decode, 1,000×1,000 (shown, like Chromium's partial PNGs); an
unstaged HEIC (Index and Working copy panes, both thumbnails, "Same size"). No `pasta-lite-thumb-*`
folder was left in the temp folder after these runs. After the review (macOS 15.7, same versions):
`portrait.heic` "HEIC · 64×96 · 598 B · Preview by macOS" and `portrait.tiff` "TIFF · 64×96 · 966 B ·
Preview by macOS", each a decoded 64×96 thumbnail (I4 left both "preview not supported").

**Tests.** `test/os-thumbnail.test.js` (a fake `thumbnail` call: the platforms, Linux null, the
request size, the answer check with QuickLook's icon, the temp copy's name, modes and removal, refused
and failed answers, no dimensions, an unwritable temp folder, cancel before / while the OS works, the
timeout, the concurrency limit and a cancel while waiting); `test/image-preview.test.js` (the ops
with a fake thumbnailer: HEIC / TIFF / PSD from a commit, the worktree and the index, never a tier 1
side, a failure stays `unsupported`, `knownKey` of either key reads nothing and asks nothing, the caps
and Load preview, an LFS object, a cancel while the OS works, none on Linux; `imageSide` with
`thumbnails`, `thumbnailSide`); `test/image-format.test.js` (TIFF dimensions, truncations, the new
fixtures); `test/image-model.test.js` (the thumbnail's metadata line, delta, alt text). After the
review: `test/os-thumbnail.test.js` also covers Windows null, a turned answer, one deadline over the
wait and the call, abandoned hung calls and their cap, `busy` and `sweep`; `test/image-format.test.js`
`irot`, `pitm` / `ipma` (versions 0 and 1), TIFF Orientation, cut heads and the bounded sniff;
`test/image-preview.test.js` a turned HEIC and TIFF through the ops, a backslash in a tracked name, a
blobless clone; and `test/blob-revisions.test.js` the file side's read (rewritten, swapped, deleted,
saved in place while read, cancelled, a multi-chunk LFS object) and partial clones (nothing fetched).

**Known limitations.**
- **No Windows thumbnails**: Electron's Windows call blocks the main thread (see above). Option B
  (decoders in a worker) or a thumbnailer in a utility process would be the way.
- **QuickLook's icon of a square image** passes the answer check when it isn't larger than the image
  (a broken 1,024×1,024 HEIC with a readable header could show the HEIC document icon). The icon of
  an image that isn't (within a pixel) square is always refused.
- **Not pixel-exact**: the OS's rendering (colour management, a PSD's saved composite), at most 2,048
  px; a swipe or difference against a full-size side compares at the thumbnail's size.
- A temp folder is left behind only if the app dies while the OS works on it (or an OS call hangs
  past the 2 s wait at quit); the next start removes it once it is an hour old.
- Linux: none (option B would be the way); JPEG XL and `.svgz` unchanged.

---

## 8. Security

| Concern | Measure |
|---|---|
| CSP | `renderer/index.html:5`: `img-src 'self' data:` → `img-src 'self' data: blob:`. Nothing else changes: no `media-src`, no remote hosts, no `'unsafe-*'`, `object-src 'none'` stays. `renderer/tabs.html:5` stays unchanged (the strip shows no images). A test reads both files and asserts the exact `img-src` lists |
| SVG scripts | Only ever `<img src="blob:…">` with MIME `image/svg+xml` (secure static mode: no script, no external loads, no animations driven by script). Never `innerHTML`, `<object>`, `<embed>`, `<iframe>`, or an SVG element in the DOM. SVG > 5 MB isn't loaded (XML parse cost in the page process) |
| MIME confusion | MIME from the sniffed format only. `not-image` bytes are never put in a Blob |
| Object URLs | Created only by `PLImageCache`, revoked on eviction, `clear()`, repo switch and unmount. Navigation to them is impossible: `will-navigate` is blocked and window.open is denied for every web contents (`main.js:292-298`) |
| Path traversal | Paths pass `relPath` (`src/op-validators.js:37-46`: no absolute, `..`, `.git` aliases, empty segments, NTFS streams). Worktree reads also pass `worktreeGuard().check` (no symlinked components, not outside the worktree or into a git dir) and `O_NOFOLLOW`. Untracked reads need `isUntracked`. The renderer never names an oid, a rev or an absolute path: main resolves them from the spec |
| Resource exhaustion | Size checked **before** reading (ls-tree size, batch-check, fstat). Hard cap 50 MB, `maxBytes` on git, pixel cap by header, SVG cap. Every sniff / dimension parser is bounds-checked |
| Other repos' programs | No filters, textconv, `git lfs`, external diff or anything else runs for a preview. Reads are `ls-tree`, `ls-files`, `cat-file` and fs reads, all covered by `GLOBAL_ARGS` (`src/git-process.js:65-84`) |
| Sandbox | Unchanged: `contextIsolation`, `sandbox`, `nodeIntegration: false`, `webSecurity` (`main/window.js:24-30`). Decoding stays in the sandboxed renderer (Tier 1) or in main's worker / the OS (I4) |

---

## 9. Performance

- **Lazy**: nothing is fetched until a diff whose `wantsPreview` is true is open. Sides load in
  parallel, and `<img decoding="async">` keeps decoding off the main thread.
- **Cheap reloads**: `knownKey` turns an unchanged side into one metadata call. The LRU keeps
  recently viewed commits instant.
- **Memory**: ≤ 2 × 20 MB in flight by default. The LRU budget is 256 MB of encoded bytes (decoded
  bitmaps are Chromium's to manage). Revoked URLs free the Blob.
- **Main process**: git does the I/O, fs is async, no decoding in main (until I4's worker).
- **Fast selection changes** (j/k through commits with the diff open, typing through a file
  list): the previous opIds are cancelled, and git is killed.

---

## 10. Testing

The project's runner and layout: `node --test test/*.test.js`, one file per area; git-layer tests
against throwaway repos (`test/helpers.js`), renderer tests with `test/renderer-harness.js`.

### 10.1 Unit: `test/image-format.test.js` (new)

Fixture bytes are built in the test (hex literals or a tiny PNG made with `zlib`), so no binary
files are needed for sniffing:
- every format in §3.1: minimal valid headers → the right `format` and `mime`, `tier`
- variants: WebP `VP8 ` / `VP8L` / `VP8X` (animated bit), APNG `acTL`, GIF single / multi frame,
  AVIF `avif` vs `avis`, HEIC `heic` and `mif1` + `heic`, ICO vs CUR, TIFF II / MM / BigTIFF,
  JXL codestream and container, BMP top-down (negative height)
- **mislabeled**: `.png` with JPEG bytes → `jpeg`, `mismatch: true`; `.webp` with text →
  `not-image`; `.jpg` with SVG text → `svg` + mismatch; no extension + PNG bytes → `png`
- SVG sniff: BOM, `<?xml?>`, comments, `<!DOCTYPE svg>`, leading whitespace, `<svg` after 4 KiB →
  not SVG; HTML (`<html>`) → not SVG
- dimensions: PNG IHDR; JPEG with an APP1 / EXIF segment before SOF0 and with SOF2; WebP canvas for
  all three chunks; GIF; ICO 0 = 256; AVIF `ispe`; SVG width / height / viewBox / none
- hostile input: truncated headers at every byte length up to 64 → null, never a throw; a JPEG
  marker loop; a box with size 0 / 1 / beyond the buffer
- LFS pointer: valid; extra keys; missing oid; non-hex oid; size not a number; > 1,024 bytes
- `POLICY` is frozen; the catalogue loads under the harness as `window.PLImageFormat`

### 10.2 Adapter and ops: `test/image-preview.test.js` (new, git-backed)

- Commit spec: modified, added (`old` absent), deleted (`new` absent), renamed with `orig` (`-M`),
  root commit (empty-tree base), a stash commit, a merge commit (first parent)
- Workdir: unstaged (index vs worktree), staged (HEAD vs index), staged in an unborn repo (`old`
  absent), staged rename (`orig`), untracked, unstaged deletion
- Special: a symlink entry and a submodule → `special`, nothing read
- Guards: untracked path through a symlinked folder → refused (`symlink` / `outside` / `stale`);
  `relPath` refusals (`../x.png`, `/abs.png`, `.git/x`, `a//b.png`) → `invalid-args`; `side` not
  old / new → `invalid-args`
- Caps (injected small caps through a `testHooks` policy override, like `hunks.testHooks`): soft →
  `too-large` + `soft`, `force` loads; hard → never read (a fake git binary that fails if `cat-file
  blob` runs, the pattern of `test/exec.test.js:174-184`); pixel cap
- `knownKey`: same key → `unchanged` without `cat-file blob`; changed worktree file → new key
- LFS pointer committed (no git-lfs installed) → `lfs-pointer` with oid / size; I3: the object
  placed in `.git/lfs/objects/…` → `image`, and a corrupted copy (hash mismatch) → `lfs-pointer`
- Cancellation: an opId cancel while `cat-file` runs → kind `aborted` (the pattern of the existing
  cancel tests in `test/ops.test.js`)
- Bare repo: `commitImageSide` works; `workdirImageSide` refused (`bare-repo`)
- Registry: add both names to the read list in `test/ops.test.js:29`; `test/bare.test.js:108`
  covers the classification. No new channel, so `test/ipc-contract.test.js` needs no change.
  Add an assertion that both ops are reachable through `opRequest`.

### 10.3 Renderer

- `test/image-model.test.js` (new, pure): `wantsPreview` for binary / text / multi-section /
  conflict / symlink / extension-only; labels; `formatBytes`; delta and % (old 0 → no %); Fit /
  100% / zoom-step math; mode availability.
- `test/image-cache.test.js` (new): an LRU with a fake `URL`: create / revoke counts, byte budget,
  pinning, `clear`, re-`put` of a key that exists.
- `test/store.test.js` (extend, with the harness's controllable fake IPC): preview loads after a
  binary diff lands; rapid spec switches → older sides cancelled (`app.cancel` called) and never
  land; reload with `knownKey` keeps the `url`; repo switch clears the cache; bytes never appear
  in `state.diff` or `state.imagePreview`.
- `test/diff-view.test.js` (extend): `emptyText` / `stagingNote` unchanged for binary files; the
  header badge rule.
- A DOM-level test of `image-preview.js` if the harness's fake DOM supports it, in the style of
  `test/rebase-editor-ui.test.js`; otherwise the smoke run covers the DOM.
- CSP assertion test (§8).

### 10.4 End to end (smoke) and the manual checklist

- `scripts/demo-repo.js` gains an `images/` folder: `logo.png` (committed, then modified),
  `hero.webp` (animated, modified in the worktree), `icon.svg` (text diff), `photo.jpg` (EXIF
  rotated), `mislabeled.png` (JPEG bytes), `sprite.gif` (animated), `big.avif`, `scan.heic`
  (Tier 2 → `unsupported`), an LFS pointer file. These are small fixture files committed under
  `test/fixtures/images/`, generated once.
- A `PL_SMOKE_JS` script (`main/smoke.js`) opens the WebP diff, waits for both `<img>` elements'
  `decode()`, asserts `naturalWidth > 0` through `PROBE`, and saves the screenshot for the PR.
- Manual checklist (record OS and git version, as the PR template asks):
  1. Unstaged `.webp` change: Before / After, sizes, Δ
  2. Staged, untracked, deleted, added, renamed image
  3. Commit details and a stash: an image file
  4. SVG with `<script>` and `onload` in it: renders, nothing runs (no console output, no network)
  5. `.png` holding a JPEG: previews, with the mismatch note
  6. 30 MB PNG: "Large image" + Load preview; 60 MB: too large
  7. Corrupt PNG (truncated): "Couldn't decode"
  8. HEIC: "HEIC — preview not supported"
  9. LFS-tracked image without the object: pointer message; worktree side shows
  10. j/k quickly through 50 commits that touch images: no stale image lands, memory stays flat
  11. Bare repository: commit images preview
  12. Checkerboard visible behind a transparent PNG; Fit vs 100% on a 4,000 px image and a 16 px
      icon
  13. Swipe / onion / difference (I3), keyboard only

---

## 11. Delivery

### 11.1 I1: Backend foundation (M)

**Tasks**
1. `src/image-format.js`: catalogue, `sniff`, `dimensions`, `parseLfsPointer`, `POLICY`.
2. `src/blob-revisions.js`: `resolveSide`, `readRevision` (git and worktree), moving `indexEntry`
   / `headEntry` out of `src/hunks.js` (`hunks.js` keeps using them).
3. `src/image-preview.js`: `imageSide()`.
4. `src/ops.js`: `commitImageSide`, `workdirImageSide` (+ argument helpers in
   `src/op-validators.js` if `side` / options need a shared validator).
5. Tests §10.1, §10.2.

**File changes**: new `src/image-format.js`, `src/blob-revisions.js`, `src/image-preview.js`,
`test/image-format.test.js`, `test/image-preview.test.js`; edited `src/ops.js`, `src/hunks.js`
(imports), `test/ops.test.js`, `CONTRIBUTING.md` (Architecture: a line on the preview path).

**Acceptance**
- `ops.createRunner().run(dir, 'workdirImageSide', ['a.webp', {}, 'new'])` resolves
  `{kind: 'image', format: 'webp', mime: 'image/webp', bytes}` equal to the file.
- The commit / staged / untracked / renamed / added / deleted matrix resolves the right sources.
- Over-cap blobs are never read; symlinked or outside paths are refused; cancel kills git.
- `npm test` and `npm run lint` are clean.

### 11.2 I2: Side-by-side preview (M) — the user-visible fix

**Tasks**
1. CSP `blob:` in `renderer/index.html:5` (+ the CSP test).
2. `renderer/image-cache.js` (`PLImageCache`), `renderer/components/image-model.js` (`PLImage`),
   `renderer/components/image-preview.js` (`PLImagePreview`), `renderer/components/image-preview.css`.
3. `renderer/index.html`: `<script src="../src/image-format.js">` next to `../src/error-kinds.js`,
   then the new scripts before `components/diff-view.js`, and the stylesheet link.
4. `eslint.config.js:21-25`: add `PLImage`, `PLImageCache`, `PLImageFormat`, `PLImagePreview` to
   `RENDERER_GLOBALS`, and `src/image-format.js` to the renderer files block (`:54`) like
   `src/error-kinds.js`.
5. `renderer/store.js`: `imagePreview` key, `loadImagePreview`, reload with `knownKey`,
   cancellation, cache clear on repo switch.
6. `renderer/components/diff-view.js`: mount the preview in `layoutBody`; badge `image`;
   `renderer/components/diff-model.js` unchanged except a helper reuse if needed.
7. `renderer/style.css`: `--checker-a`, `--checker-b`.
8. `test/renderer-harness.js`: load the new scripts in `loadComponentHelpers`.
9. Tests §10.3; smoke screenshot.
10. `CHANGELOG.md` `[Unreleased]` → **Added**: "Image preview in the diff view: PNG, JPEG, GIF,
    WebP, AVIF, BMP, ICO and SVG files show before and after side by side, with dimensions, file
    size and the size change, on a checkerboard for transparency, at Fit or 100%. Large images
    load on request; Git LFS pointers and formats that can't be shown say so." README.md line 30
    ("each file's diff") → "each file's diff, with a before / after preview for images"; a new
    screenshot `docs/screenshots/image-diff.png` if the README shows one.

**Acceptance**
- Selecting a changed `.webp` (unstaged, staged, untracked, in a commit, in a stash) shows Before /
  After with format, W×H, size and Δ, instead of "Binary file — no preview".
- An SVG containing `<script>alert(1)</script>` and `onload` renders and runs nothing.
- Switching files quickly never shows a previous file's image; cancelled reads appear as
  `aborted` in the ops log, not as errors.
- Non-images keep "Binary file — no preview"; Tier 2 formats say "<Format> — preview not supported".
- No new lint findings; `npm test` green on macOS and Ubuntu CI.

### 11.3 I3: Text-backed images and comparison (M)

**Tasks**: the Preview | Text toggle for SVG and LFS pointers (`wantsPreview` extension path);
the local LFS cache read (`lfs-cache` source, sha256 check); swipe / onion / difference; zoom in
/ out and the `KEYS` entries; conflicted binary images (stages 1 / 2 / 3, panes labelled "Base",
"Ours (HEAD)", "Theirs (<branch>)" via the existing rebase / merge naming); demo-repo images and
the smoke script; CHANGELOG entry.

**Acceptance**: an SVG change can be flipped between the rendered preview and the text diff, and
the choice persists for the session; an LFS image whose object is in `.git/lfs/objects` previews
with no network or `git lfs` process (verified with the network off and git-lfs uninstalled);
the three modes work by mouse and keyboard; a binary image conflict shows ours / theirs.

### 11.4 I4: Tier 2 (gated, Q2)

**Tasks (option A)**: `src/os-thumbnail.js` is free of Electron like the rest of `src/`, with the
`nativeImage` thumbnailer passed in from `main.js` (the composition root). An app-private temp
folder (0700), 0600 files, `finally` unlink; dims of the thumbnail; `ImageSide` with
`source: 'os-thumbnail'`, `format` = the original, `mime: 'image/png'`; Linux → stays
`unsupported`. Tests with a fake thumbnailer; a manual macOS check with HEIC, TIFF and PSD files.

**Acceptance**: on macOS a HEIC, a multi-page TIFF (first page) and a PSD show a preview labelled
"Preview by macOS"; no temp file is left behind (also after a cancel).

### 11.5 Definition of done (whole feature)

- I1 + I2 merged; I3 merged or explicitly split into a follow-up issue; I4 decided (Q2).
- Every state in §6.2 reachable and covered by a test or the manual checklist.
- `npm test`, `npm run lint` clean; the CI matrix green.
- CSP change reviewed; the SVG and path-traversal checks in the manual checklist recorded in the PR.
- CHANGELOG `[Unreleased]` and README updated; this plan's Status line updated ("I1–I2 built"),
  and roadmap.md line 81 changed to "**Partial**. Image preview built (image-preview.md); split
  view, whitespace and word wrap still missing".
- Header comments of the touched modules updated (CONTRIBUTING.md "Pull requests").

---

## 12. Risks

| Risk | Mitigation |
|---|---|
| `blob:` URLs from a `file://` page: an opaque origin may surprise (Chromium creates `blob:null/…` for `file:` pages) | I2 starts with a 30-minute spike: create a blob URL in the real app and load it in an `<img>` under the new CSP. Fallback: `data:` URLs (already allowed by the CSP) for sides under the soft cap |
| Large IPC payloads (structured clone of 20–50 MB) stall main briefly | Soft cap 20 MB by default; the hard cap 50 MB; parallel sides; Q1 can lower it |
| Chromium decodes a 100 MP image into ~400 MB of bitmap | Pixel cap by header; `decoding="async"`; one preview at a time (LRU holds encoded bytes only) |
| Format sniffers parse hostile bytes | Bounds-checked parsers, a fuzz-style loop over truncations in tests; no decoding in main |
| LFS cache layout differs (`lfs.storage`, custom transfer agents) | I3 reads only the default layout and verifies sha256; anything else stays `lfs-pointer` |
| EXIF orientation: header dims ≠ displayed dims | Displayed dims always from `naturalWidth` / `naturalHeight` |
| Keyboard shortcut collisions | I3 checks the whole `KEYS` table; keys active only while a preview has focus |
| I4 option A on Windows depends on installed codecs | Labelled per platform; falls back to `unsupported` when the thumbnail call rejects |

---

## 13. Open questions for you

1. **Caps**: soft 20 MB (Load preview button), hard 50 MB, SVG 5 MB, 100 megapixels: OK, or
   different numbers?
2. **Tier 2 (HEIC / TIFF / PSD)**: (a) defer entirely, (b) the macOS / Windows OS thumbnailer (no
   dependencies; recommended if you want them), or (c) JS / WASM decoders (~+10 MB per DMG, the
   first runtime dependencies, LGPL `libheif-js`, an HEVC patent question for distribution)?
   `sharp` is not recommended (no HEIC in its prebuilt binaries, native packaging cost).
3. **Git LFS**: is reading the local LFS cache (I3, no network) enough, or should a missing
   object be fetchable (`git lfs` would run: network, credentials, the risky-config trust prompt)?
4. **SVG default**: when an SVG has a text diff, should the preview or the text be shown first?
   Proposal: text first (it is the reviewable change), the toggle remembered for the session.
5. **Comparison modes**: are swipe / onion skin / difference worth I3, or is side by side enough
   for now?
6. **`.svgz`**: support it (gunzip in main, then SVG) or leave it `unsupported`?
7. **JPEG XL**: leave it until Chromium enables it by default (proposal), or turn on Chromium's
   experimental decoder in the app?
8. **Units**: binary (1 KB = 1,024 B, like most git tools) or decimal (Finder on macOS)?
9. **Badge**: replace the `binary` badge with `image` for previewable files, or show both?
10. **Conflicted binary images (I3)**: worth doing here, or leave them for the conflict-editor work
    (roadmap P5b)?
