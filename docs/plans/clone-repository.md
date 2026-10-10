# Pasta Lite: clone a repository

Plan for "Clone Repository…": the user enters a remote URL (remotes only: a local source was
removed after user testing, §15), picks a parent folder with the native folder dialog, keeps or edits a folder
name derived from the source, and watches `git clone` run with progress and a Cancel button. When
the clone is done, the repository opens through the same path as Open Repository (the trust check,
the tab, the recent list). Today the app can only open repositories that already exist: README.md
line 149 says "No clone or init", and nothing in `src/` runs `git clone`.

Status: **built (C1–C5)**, with the review's fixes, on `feat/clone-repository`; the manual QA of
§11.3 (macOS and Windows 11) is still to do. §15 records where the build differs from this plan. Written 2026-10-09 on `feat/clone-repository`, branched from
`main` at `9cfffcb` (after the Windows alpha work, `8c59872` / `bf25b02`). Revised the same day
after an expert review (findings H1–H3, M1–M10, L1–L12; §13 records the decisions). The roadmap
lists clone as part of **P3b: Clone, Init, auto-fetch** ([roadmap.md](roadmap.md) §3.6, §1.1 row
"Clone"), and it depends on P2's URL validator (§3.4) and P3a's credential prompts (§3.5). Neither
of those is built yet. This plan takes clone forward on its own: it builds the URL validator P2
needs, and it works without credential prompts (§2.3). Init, auto-fetch and the prompts stay in the
roadmap.

**Sources.**
- The code, read directly (file and line numbers below are from `9cfffcb`).
- git facts marked **(verified)** were checked with git 2.51.2 on macOS 15, in throwaway
  repositories in the session scratchpad (not this repo), against a local bare repo, `file://`
  URLs, and a local Node HTTP server that answers 401 / 404 or never answers.
- Windows facts not marked verified come from the existing code and its comments
  (`src/git-process.js` `signalGroup`, CONTRIBUTING.md "Tests"). They are checked in C2's Windows CI
  job and the manual QA (§11.3).

**Size scale** (the same LOC style as rebase.md, roadmap.md and image-preview.md, tests included):
**S** < 500 LOC, **M** 500–1,500, **L** 1,500–3,000.

---

## 1. Summary

### 1.1 Milestones

| Milestone | Scope | Size |
|---|---|---|
| **C1** | Pure core, no visible change: `src/clone-url.js` (classify and validate a typed network URL, derive the folder name, validate a folder name, a display form; shared with the renderer like `src/error-kinds.js`), `src/path-names.js` (the `.git` alias and Windows device-name rules moved out of `src/worktree-fs.js`), `src/display-text.js` (the invisible-character class moved out of `renderer/components.js`), `src/clone-progress.js` (a parser for `git clone --progress` stderr) | M (~1.0k LOC, ~60% tests) |
| **C2** | Backend: an `onStderr` tap on `spawnGit`, `src/clone.js` (`cloneRepo`: create the target folder, run git, classify failures, hand back what we created for removal), `src/clone-cleanup.js` (async removal of only what we created, persisted so a quit can't abandon it), new git-errors rules and error kinds, and integration tests that clone local bare fixtures over `file://`, with cancel, checkout-failure and cleanup tests (including Windows) | M (~1.3k LOC) |
| **C3** | Main wiring: `src/clone-service.js` (the use cases behind the IPC, free of Electron), the `clone` app op in the shared runner (so quitting and closing a tab ask first), four IPC channels and one event, the preload API, `createClonePrefs` in `src/recent.js` (last parent, pending cleanups), `openCloned` and an open-with-reason in `src/repo-opening.js`, the quit guard's clone wording, File > Clone Repository… (⇧⌘N) | M (~1.3k LOC) |
| **C4** | Renderer: an `onDismiss` veto on `renderer/dialog.js`'s `modal`, `renderer/clone.js` (`window.PLClone`: three chained modals: the form, progress, the outcome), a Clone… button on the start screen and in the repository picker, `menu-command` handling, reattaching after a reload, CSS, harness tests | M (~1.2k LOC) |
| **C5** | Docs and QA: README, CHANGELOG, CONTRIBUTING's architecture notes, SECURITY.md, a smoke script, and the manual QA on macOS and Windows (§11.3) | S |

Each milestone ends with `npm test` and `npm run lint` green and is reviewable on its own. C1 and
C2 add no UI. C3's menu item does something visible only once C4 lands, so C3 and C4 are best
merged together (or the menu item moves to C4).

### 1.2 Key decisions

1. **The page never sends a filesystem path, and never names a local source.** This is the app's
   security boundary (`main.js:15-18`, `main/ipc.js:6-11`, `src/repo-opening.js:6-9`), and clone
   keeps it in full:
   - The **parent folder** comes from main's native folder dialog or from main's remembered value
     (last used, else home). The page sees only a display string (`~/code`).
   - **Remotes only.** There is no local source: a typed local path, `file://` URL (any host), UNC
     path (`\\server\share`), Windows device path (`\\?\`, `\\.\`) or drive-relative path
     (`C:repo`) is refused by `parseCloneUrl`. A compromised page could otherwise clone any private
     repository on the machine into a folder it then opens and reads, or make Windows send the
     user's NTLM hash to a UNC host. (A "Choose Local Repository…" folder dialog was built and then
     removed after user testing, §15.)
   - The page sends a **typed network URL** (https, http, ssh, scp-like, git) and a **single path
     segment** (the folder name). Main builds the target path itself.
   - The one thing a page still chooses is a network destination for git. That is the feature
     itself, and §8 records it as an accepted risk.
2. **Clone runs as an "app op" in the shared runner**, not through the `op` channel (which needs a
   repo: `src/ipc-contract.js:79`). It is registered next to `ops.OPS` but not in it, so
   `opRequest` (`src/ipc-contract.js:65-70`) still refuses it by name. Being in the same runner
   gives clone, for free, the quit guard, the tab close guard, the tab strip's busy indicator,
   cancellation by opId through the existing `app:cancel`, and the one log record per op
   (`src/runner.js`).
3. **We create the target folder ourselves, and remove only that folder, asynchronously and
   resumably.** `fs.promises.mkdir(target)` refuses if anything is there, so we never clone into,
   or later delete, a folder we didn't make. We record its identity (dev + ino). The op settles as
   soon as git is dead. Removal of a failed or cancelled clone then runs separately with
   `fs.promises.rm`, tracked by the clone service. It is written to `clone.json` before it starts,
   so a quit, or a crash, leaves it to finish on the next launch, after the identity is checked
   again. Removal can be long: a SIGTERM during "Updating files" leaves the full checkout behind,
   and a Windows hard kill (`taskkill /F`, `src/git-process.js:216-264`) leaves everything
   **(verified: SIGKILL leaves the folder)**.
4. **A transport allowlist on the clone command line**: `-c protocol.allow=never`,
   `protocol.{https,http,ssh,git}.allow=always`, `protocol.file.allow=user`.
   - This blocks `fd::`, which without the allowlist makes clone hang reading fd 3 **(verified)**,
     and every other `<helper>::` transport. `ext::` is already blocked by `GLOBAL_ARGS`.
   - `file` stays at git's default `user`, not `always`. Command-line `-c` values reach child gits
     through `GIT_CONFIG_PARAMETERS` (the inheritance the `GLOBAL_ARGS` comment relies on,
     `src/git-process.js:86-89`), and `always` would undo git's CVE-2022-39253 hardening for
     submodules, which run with `GIT_PROTOCOL_FROM_USER=0`. The roadmap's sketch keeps `user` too
     (roadmap.md:702). A top-level clone of a local repository still works with `user`
     **(verified)**: the app has no local source, but the tests clone their local fixtures.
   - We do **not** set `GIT_PROTOCOL_FROM_USER=0` ourselves: it refuses local and `file://` clones
     outright **(verified)**.
   - The URL is validated before git runs, and it always follows `--`.
5. **No interactive prompts, no overall timeout, Cancel always works.** Clone inherits
   `GIT_TERMINAL_PROMPT=0` and the detached, tty-less spawn of every git command
   (`src/git-process.js:127-146`, `:498-506`), so git never asks on a terminal. Credential helpers
   (osxkeychain, Git Credential Manager) and ssh-agent work as they do for fetch. Clone has no
   timeout: a large repository can take an hour, and GCM may be waiting for the user to sign in.
   The page says "Waiting…" after 30 s without a progress frame (§7.2).
6. **The MVP is a plain full clone of the default branch, without submodules.** Shallow clones, a
   branch choice, partial clones and `--recurse-submodules` are later options (§2.2). After a clone
   with a `.gitmodules`, the app says the submodules were not cloned.
7. **Failures are kinds, and "checkout failed" is a result.**
   - New kinds: `exists`, `unreachable`, `host-key`, `no-access`, `no-space`, `path-too-long`.
     Existing kinds reused: `not-found` (no such remote repository), `auth`, `aborted`,
     `unsupported`, `unsafe-repo`, `stale`, `in-progress`.
   - "Clone succeeded, but checkout failed" (exit 128 with the repository kept, **verified** with a
     300-byte file name) resolves `{status: 'checkout-failed'}`, and the dialog offers to open the
     repository anyway. This follows rebase.md decision 3: a stop is a result, not an error.
   - A cancel wins: `kind === 'aborted'` is checked before anything else, because `spawnGit`
     replaces stderr with "git was cancelled" when it kills git (`src/git-process.js:557-563`).
8. **Only main sees the URL's secrets, and the logs see none of it.**
   - The URL never goes into a log record: `summarizeArgs` (`src/redact.js:111-139`) turns
     everything after `--` into a count.
   - `app:clone` failures are logged like `op` failures, as `{name, kind, code, exitCode}` only
     (`logError`, `src/ipc-errors.js:87-94`), not the full error (`main/ipc.js:90`).
   - Error messages sent to the page go through `redactString`.
   - An https URL with a password, a token-shaped or unusual user name, or a `?` / `#` is refused
     before git runs, because git would store it in plain text in `.git/config`.

---

## 2. Scope

### 2.1 MVP (C1–C5)

- Clone from a typed `https://`, `http://` (with a "not encrypted" note), `ssh://`, scp-like
  `user@host:path`, or `git://` (with the same note) URL. Remotes only.
- Clone into `<parent>/<name>`. The parent is picked natively and remembered. The name is derived
  from the source and can be edited.
- Progress by phase (Receiving objects 45% · 12.3 MiB · 4.1 MiB/s, Resolving deltas, Updating
  files), Cancel, and removal of the partial folder (finished at the next launch if a quit
  interrupts it).
- Errors explained by kind (auth, not found, unreachable, unknown host key, folder exists, no
  access, no space, path too long, cancelled, unsupported transport), with git's sanitized text as
  the detail.
- On success: open in this tab (start screen) or a new tab (when the tab already has a repo), with
  the trust check, the recent list and the tab strip, exactly as Open Repository does.
- Entry points: File > Clone Repository… (⇧⌘N / Ctrl+Shift+N), a **Clone…** button on the start
  screen, and **Clone…** in the repository picker's footer.

### 2.2 Later, not in this plan

| Option | Why not now |
|---|---|
| `--depth N` / `--shallow-since` (shallow) | Shallow histories affect the graph (a cut-off history), undo, rebase plans and `merge-base`. The app has never been tested on a shallow repo. Add it behind an "Advanced" disclosure once a shallow repo has had its own test pass. S once that is done |
| `--branch <b>` | Cheap, but it needs the remote's branch list before cloning (`ls-remote`, another network round trip with the same auth questions). Users can check out another branch right after opening. S |
| `--recurse-submodules` | Submodule URLs come from the cloned repository, not from the user, so `protocol.file.allow` for submodules, the submodules' own hooks and config, and the trust check of every nested git dir (`git.riskyNested`) all apply. The app keeps git out of submodules everywhere (`GLOBAL_ARGS` comment, `src/git-process.js:90-97`). That needs its own design. For now the notice (decision 6) points to the terminal |
| `--filter=blob:none` (partial clone) | The image preview already handles missing blobs (`not-local`, image-preview.md §5.7), but diffs, blame and undo would fetch lazily over the network without credential prompts. Later, together with P3a |
| `--bare` / `--mirror` | Bare repos open today, and a mirror is guarded (`src/bare-gate.js`). Few users want this from a GUI. Later, if asked |
| Cloning into an existing **empty** folder | git allows it, but cleaning up safely after a cancel then means deleting only what git wrote inside a folder we don't own. Decided for the MVP: refused with `exists` (§13 Q3) |
| Local sources (paths, `file://` URLs) | Refused by design (decision 1): remotes only. A folder-dialog local source was built and removed after user testing (§15) |
| Credential and passphrase prompts | Roadmap P3a (askpass helper, socket, token). Clone works with helpers and agents now, and the auth dialog explains what to do (§7.2) |
| Init (New Repository…) | Roadmap P3b, a separate small feature. It reuses C1's name rules and C3's parent picker |
| A generic `dialog.form({fields})` | The roadmap's planned two-field form contract (roadmap.md:528-529). Clone builds its form on the existing `modal` builder (§7.3); a later `dialog.form` can absorb it |
| Clone from a hosting account | Roadmap P7 (OAuth) |

### 2.3 Dependencies

- **P2's URL validator** (roadmap §3.4, `src/urls.js`): this plan builds it as `src/clone-url.js`
  for network URLs. When P2's remote management lands, it can rename or re-export the module. The
  rules match the roadmap's, except that local paths and `file://` are refused when typed (decision
  1). P2's "add remote" should make the same choice.
- **P3a credential prompts**: not needed. Clone behaves like fetch does today (`authAlert`,
  `renderer/flows-kit.js:213-226`). When P3a lands, its `askpass` env scope applies to clone as it
  does to `remoteOp`.

---

## 3. Git mechanics

### 3.1 The command

```
git <GLOBAL_ARGS>                                      # src/git-process.js:71-104 (gitAt prepends them)
    -c protocol.allow=never
    -c protocol.https.allow=always -c protocol.http.allow=always
    -c protocol.ssh.allow=always   -c protocol.git.allow=always
    -c protocol.file.allow=user
    clone --progress --no-recurse-submodules -- <source> <target>
```

- **`<source>`** is a validated network URL typed by the user, or the absolute path of the local
  repository main's folder dialog returned (never a page string).
- **cwd** is the parent folder, run with `gitAt(parent, …)` (`src/git-process.js:598-600`), not
  `exec.run`. `exec.run` resolves the enclosing worktree root (`src/exec.js:26-28`), which is wrong
  for a folder that isn't a repository yet. A parent inside another repository is fine: clone does
  not read the enclosing repository's local config. A `url.<x>.insteadOf` in an enclosing repo's
  `.git/config` was **not** applied **(verified)**.
- **`<target>`** is absolute and already exists as an empty folder that we created (§5.3). git
  clones into an existing empty directory **(verified)**.
- **`--progress`**: git prints progress only to a tty unless asked. With `--progress`, stderr gets
  `\r`-separated frames and `\n`-terminated lines **(verified)** (§5.2).
- **`--no-recurse-submodules`**: explicit, whatever the user's config says.
- **Env**: `baseEnv()` (`src/git-process.js:127-146`): `LC_ALL=C` (English messages, so the
  progress format and error patterns are stable), `GIT_TERMINAL_PROMPT=0`, the `GIT_*` allowlist
  (`GIT_SSH`, `GIT_SSH_COMMAND`, `GIT_ASKPASS`, proxies and `GIT_SSL_*` pass through), and
  `GIT_EDITOR=true`. On Windows, `PASTA_LITE_GIT_ID` too. Nothing is added for clone (but see §9.3
  for a possible `core.sshCommand` on Windows).
- **Detached and hidden**: POSIX: `detached: true`, so no controlling tty and ssh can't prompt.
  Windows: `windowsHide`, a hidden console (`src/git-process.js:498-506`). See §9.3.
- **No timeout**: `spawnGit` sets a timer only when `timeout` is given (`:533`). The fetch timeout
  (`REMOTE_TIMEOUT_MS = 120000`, `src/remote.js:13`) is deliberately not used.
- **Output cap**: `maxBytes: 16 * 1024 * 1024` instead of the default 256 MiB (`MAX_OUTPUT_BYTES`,
  `src/git-process.js:483`). stdout is empty, and stderr is about one 60-byte frame per percent per
  phase plus throughput updates about once a second. A ten-hour clone stays near 2 MiB, so the cap
  stops a misbehaving server's endless `remote:` output without ever cutting a real clone short.

### 3.2 Verified behaviours (git 2.51.2)

| # | Case | git's behaviour |
|---|---|---|
| 1 | Clone into a pre-created empty folder | works, exit 0 |
| 2 | Destination exists and isn't empty | `fatal: destination path '<p>' already exists and is not an empty directory.`, exit 128 |
| 3 | Local path that isn't a repo | `fatal: repository '<p>' does not exist`, exit 128, no folder left |
| 4 | A local **path** (not `file://`) | the local fast path (hardlinks): stderr has only `Cloning into '<p>'...` and `done.`, **no progress frames** |
| 5 | `file://` URL | the pack protocol: `remote: Enumerating objects`, `remote: Counting objects: N% (a/b)`, `remote: Compressing objects`, `Receiving objects: N% (a/b), X MiB \| Y MiB/s`, `Resolving deltas: N% (a/b)`, each ending `, done.` (so tests use `file://`; the app itself never passes one) |
| 6 | HTTP 404 | `fatal: repository 'http://…/x.git/' not found`, exit 128, no folder left |
| 7 | HTTP 401 | `fatal: could not read Username for 'http://…': terminal prompts disabled` (matches `RULES.auth`, `src/git-errors.js:33-44`), no folder left |
| 8 | An empty remote | exit 0, `warning: You appear to have cloned an empty repository.` (opens as an unborn HEAD, which the app supports) |
| 9 | SIGTERM while connecting, git made the folder | git removes the folder |
| 10 | SIGTERM, folder pre-created | git removes what it wrote, **keeps the empty top folder** |
| 11 | SIGKILL | everything stays (`.git/` and partial objects): the Windows `taskkill /F` case |
| 12 | `ext::…` / `fd::3` / `foo::bar` with the allowlist | `fatal: transport 'ext' not allowed` (and `'fd'`, `'foo'`), exit 128 |
| 13 | `fd::3` **without** the allowlist | **hangs** (reads fd 3) |
| 14 | `GIT_PROTOCOL_FROM_USER=0` with a local path | `fatal: transport 'file' not allowed` |
| 15 | `protocol.allow=never` + `protocol.file.allow=user`, a local path and a `file://` URL | both work, exit 0 |
| 16 | `-oProxyCommand=…:x` (scp-like) / `ssh://-oProxyCommand=x/y` | `strange pathname '…' blocked` / `strange hostname '…' blocked`: git refuses them itself; we refuse them earlier anyway |
| 17 | `https://user:secret@127.0.0.1:9/r.git`, connection refused | `fatal: unable to access 'https://127.0.0.1:9/r.git/': Failed to connect…`: curl's message drops the userinfo, but the URL would still be stored in `.git/config` |
| 18 | cwd inside another repository whose local config has `url.*.insteadOf` | not applied |
| 19 | A tree entry with a 300-byte file name (`git mktree`) | `error: cannot stat '<name>': File name too long`, `fatal: unable to checkout working tree`, `warning: Clone succeeded, but checkout failed.`, **exit 128**, `.git` kept and `HEAD` valid |

Not verified here, and to be checked in C2 (from git's sources and common output):
`Host key verification failed.` followed by `fatal: Could not read from remote repository.` (ssh, an
unknown host with no tty), `Could not resolve host: <h>`, `Connection timed out`,
`Updating files: N% (a/b)` (delayed progress, only when the checkout takes over a second),
`Filtering content: N% (a/b), X MiB | Y MiB/s` (process filters such as Git LFS), and throughput in
`bytes` units for small transfers (`, 512 bytes | 1024.00 KiB/s`).

### 3.3 Git LFS and other filters

When git-lfs is installed globally (`filter.lfs.*` in the user's config), the checkout step runs
its smudge filter, which downloads LFS objects over the network with the same credentials. That is
the user's own setup, and clone respects it. The progress shows `Filtering content`. A failure there
becomes a checkout failure (decision 7).

**This traffic is outside our transport allowlist.** git-lfs is its own program with its own HTTP
client, so `protocol.*.allow` doesn't apply to it. A hostile repository's committed `.lfsconfig`
can set `lfs.url` and send the smudge requests (and the credentials the user's helper gives for
that host) to a host of its choosing. This is an existing property of git-lfs, which any terminal
clone shares. §8 records it, and SECURITY.md's note says it.

---

## 4. Domain model

### 4.1 Where it sits

Clone belongs with **Repository Opening** (`src/repo-opening.js`: "every open of a repository"). It
produces a repository that is then opened exactly like one from the folder dialog. It maps onto the
existing layers like this:

| Role | Existing pattern | New for clone |
|---|---|---|
| Pure domain, Node + browser | `src/error-kinds.js`, `src/image-format.js` (CommonJS-or-window) | `src/clone-url.js` (`window.PLCloneUrl`), `src/path-names.js` (`window.PLPathNames`), `src/display-text.js` (`window.PLDisplayText`) |
| Pure parser, Node | `src/porcelain.js` | `src/clone-progress.js` |
| Adapter: git and fs | `src/remote.js`, `src/worktree-fs.js` | `src/clone.js` `cloneRepo`, `src/clone-cleanup.js` |
| Use cases, free of Electron | `src/repo-opening.js`, `src/repo-trust.js` | `src/clone-service.js` |
| Store | `src/recent.js` (recent.json, trusted.json) | `createClonePrefs` in `src/recent.js` (clone.json: last parent, pending cleanups) |
| Transport | `src/ipc-contract.js`, `main/ipc.js`, `preload.js` | 4 channels, 1 event, `window.api.clone` |
| Renderer view and flow | `renderer/components/repo-picker.js` (works without a repo), `renderer/dialog.js` | `renderer/clone.js` (`window.PLClone`) |

### 4.2 Terms

| Term | Meaning | Shape |
|---|---|---|
| **CloneUrl** | A validated, typed network URL (trimmed) | `{url, kind: 'https'\|'http'\|'ssh'\|'scp'\|'git', host, user \| null, path, display, notes: ['insecure'?, 'user-in-url'?]}` |
| **display** | How a URL or path is shown: a URL as typed, minus nothing secret (there is nothing secret left after validation: the user name is shown plainly, consistently for https, `ssh://` and scp-like); a path as `homeShort` (`src/fs-paths.js:130-136`) | string |
| **CloneName** | One path segment, the folder to create | string, see §4.3 |
| **Parent** | The folder the clone goes into: main's last used parent, else home | main: `{abs, display}`; the page sees `display` |
| **Made** | What we created, so we know what we may delete | `{abs, dev, ino}` (decimal strings of BigInt stats, so they survive JSON in `clone.json`; compared like `fileIdentity` / `sameFile`, `src/git-process.js:385-391`) |
| **CloneProgress** | One parsed frame | `{phase, percent \| null, current \| null, total \| null, bytes \| null, rate \| null, done: boolean, remote: boolean}` |
| **CloneResult** | What the op resolves | `{status: 'done' \| 'checkout-failed', root, name, submodules: boolean, empty: boolean, message?}` |

### 4.3 Invariants

- The name is validated (`nameError`) **before** a target path is computed from it.
- The target never existed before the op: `fs.promises.mkdir(target)` (non-recursive, so the
  parent must exist) is the first write, and `EEXIST` means kind `exists`.
- Only `Made.abs` is ever deleted, and only while `lstat` still shows a directory (not a link) with
  the same `dev` and `ino`, checked again right before removal, including at the next launch. A file
  system without inode numbers (`ino === 0`, as `sameFile` treats it, `src/git-process.js:391`)
  never matches, so nothing is deleted and the user is told where the leftover is.
- A typed source reaches git only as one argv element after `--`, after `parseCloneUrl` accepted it
  in main (the page's own check is a convenience). No local source reaches git.
- The name is one segment with no separator, not `.` / `..`, no `.git` alias, and (on Windows) no
  reserved device name, trailing dot or space, or `<>:"|?*`.
- The parent is an absolute, existing directory that main got from its own folder dialog, its
  stored preference or the home folder.
- Main does no synchronous filesystem work for clone (the rule of `src/fs-paths.js:2-15`):
  `fs.promises` throughout `cloneRepo`, the cleanup, the service and `createClonePrefs`.

---

## 5. Backend design (C1, C2)

### 5.1 `src/clone-url.js` (pure, C1)

```js
parseCloneUrl(text, {platform}) -> {ok: true, ...CloneUrl} | {ok: false, reason}
deriveName(source, {platform}) -> string     // from the typed URL; '' when nothing usable
nameError(name, {platform}) -> string | null // the inline message, null when valid
MAX_URL = 2048; MAX_NAME_BYTES = 255
```
Each function takes `{platform}` with a default: `({platform = process.platform} = {})` under Node,
and the renderer passes `window.api.platform` (`preload.js:63`) explicitly.

Classification, in order (the `text` is trimmed first; nothing else is changed):
1. Refuse: empty; longer than `MAX_URL`; any character of `INVISIBLE` (`src/display-text.js`:
   C0/C1 controls, DEL, bidi controls); a leading `-`.
2. Refuse **local sources** (remotes only) with "Enter a remote URL (https://…, ssh://…,
   git@host:…): a local path or file:// URL isn't cloned here":
   - `file:` in any case and with any host (`file:///x`, `file://host/x`, `file:x`)
   - an absolute POSIX path (`/…`) or `~…`
   - on every platform (the page can't be trusted to name its platform): a drive path `C:\…`,
     `C:/…`, a drive-relative `C:repo`, a UNC path `\\server\share\…` or `//server/share/…`, and
     Windows device paths `\\?\…` and `\\.\…`
   - a relative path (`./r`, `../r`, `r.git` with no `:`)
3. `<word>::…` (git's remote-helper syntax: `ext::`, `fd::`, `hg::` …) → refused: "This kind of
   URL runs a helper program; clone it from a terminal".
4. `scheme://…` with a scheme of `https`, `http`, `ssh` or `git` (any case) → that kind. `http`
   and `git` get the `insecure` note. Any other scheme (`ftp`, `codecommit`, `git+ssh` …) is
   refused as unsupported. The host must be non-empty and must not start with `-`.
5. scp-like `[user@]host:path` (a `:` before any `/`, git's own rule) → `scp`. The host must be at
   least two characters (a one-letter "host" is a drive letter, step 2), must not start with `-`,
   and the path must not be empty.
6. Anything else → refused.

**Userinfo rules** (https, http, `ssh://`, scp):
- A password (a `:` in the userinfo) is refused.
- A user name is allowed only if it matches `^[A-Za-z0-9._-]{1,39}$` **and** is not token-shaped.
  Token-shaped means:
  - a known prefix: the shapes of `src/redact.js:43` (`ghp_` and the other `gh?_`, `github_pat_`,
    `glpat-`, `AKIA` / `ASIA`), plus `glptt-`, `hf_`, `npm_`, `pypi-` and `xox[abpr]-`
  - or 24 or more characters of `[A-Za-z0-9]` that mix letters and digits
  The length limit already excludes Azure DevOps' 52-character PATs and Gitea's 40-hex tokens.
- An allowed user name gets the `user-in-url` note, except the conventional `git@` for scp and
  `ssh://`.
- For http(s), a `?` or `#` anywhere in the URL is refused: query strings carry tokens (`?private_token=`),
  and git stores the URL as typed.

`deriveName` follows git's `git_url_basename` in spirit. It strips, in order: trailing `/` and
`\`, a trailing `/.git`, everything up to the last `/`, `\` or (scp) `:`, then a trailing `.git` or
`.bundle`. It drops a `:port`, and for a bare host it uses the host. The result is then cleaned for
the platform: `INVISIBLE` characters removed, Windows-invalid characters replaced with `-`, and
trailing dots and spaces dropped. It is `''` when nothing valid is left, and the dialog then asks
for a name.

`nameError` (the same function main enforces):
- empty → "Enter a folder name"
- `.` or `..`
- contains `/` or `\` (refused on every OS: it must be one segment)
- over 255 UTF-8 bytes
- on Windows: `isDotGitName`, `DEVICE_NAME`, a trailing dot or space, or `<>:"|?*`
  (`src/path-names.js`)

**`src/path-names.js`** (pure, C1): `isDotGitName`, `DEVICE_NAME` and `refusedName` move here from
`src/worktree-fs.js:26-44`. `src/worktree-fs.js` imports them back, so its tests stay as they are.
The module also exports through `window.PLPathNames`. Today these rules are `_internal` only
(`src/worktree-fs.js:184-187`).

**`src/display-text.js`** (pure, C1): `INVISIBLE` and `displayName` move here from
`renderer/components.js:97-105`. `components.js` takes them through its existing `load(name, file)`
helper (`renderer/components.js:313-320`, as it loads `PLErrorKinds`), and `src/clone-url.js` and
`src/clone-progress.js` require them. One definition, no copies. (`src/repo-trust.js`'s `oneLine`,
`:13-14`, is a similar class plus U+2028 / U+2029; folding it in is a separate clean-up, not part of
this plan.)

### 5.2 `src/clone-progress.js` (pure, C1)

`createProgressParser({maxLines = 20, maxLine = 500})` →
`{feed(chunk: Buffer): CloneProgress[], end(): CloneProgress[], lines(): string[]}`.
- A `StringDecoder('utf8')` keeps multi-byte characters that are split across chunks. Text is split
  on `\r` and `\n` (`\r\n` counts as one break). Each piece is one frame.
- A frame becomes a `CloneProgress` when it matches this pattern (git's English, guaranteed by
  `LC_ALL=C`):
  ```
  ^(remote: )?(Enumerating objects|Counting objects|Compressing objects|Receiving objects|Resolving deltas|Updating files|Filtering content|Checking connectivity)
  (?:: +(\d+)% \((\d+)\/(\d+)\))?
  (?:, ([\d.]+ (?:bytes|[KMGT]iB)))?
  (?: \| ([\d.]+ (?:bytes|[KMGT]iB)\/s))?
  (?:, done\.)?
  ```
  The phases are a closed set: anything else is not progress. git prints `bytes` for amounts under
  1 KiB and `KiB` / `MiB` / `GiB` / `TiB` above.
- Other non-empty frames (`Cloning into…`, `warning:`, `error:`, `fatal:`, `remote:` text that
  isn't a progress phase) go into a ring of the last `maxLines` lines. Each line is cut to
  `maxLine` characters and stripped of `INVISIBLE` characters. `lines()` is what the error message
  and the classification are built from (§5.3, §5.6), never the full stderr, which holds hundreds of
  progress frames (309 lines for a 300-file repo **(verified)**).
- `remote:` lines are server-controlled text. They are kept as text for the error detail, and two
  of them do decide a kind: `remote: Repository not found` (`not-found`), and the existing `auth`
  rule's `remote: …403` and `remote: Invalid username or password` lines
  (`src/git-errors.js:39-40`). A hostile server can therefore choose which of those messages the user
  sees. That is harmless: no decision beyond the message depends on it.

### 5.3 `src/clone.js` `cloneRepo` (C2)

```js
/**
 * @param {{source: string, parent: string, name: string, onProgress?: (p: CloneProgress) => void,
 *   onMade?: (made: Made) => void, signal?: AbortSignal, platform?: string}} o
 *   source: a URL parseCloneUrl accepted, or a local path main's dialog returned (never a page string).
 *   platform: default process.platform (tests pass 'win32' / 'darwin').
 * @returns {Promise<CloneResult>}
 * Rejects with err.made set when a folder was created (the caller removes it, src/clone-cleanup.js).
 * Kinds: invalid-args, not-found (parent gone; remote repository not found), exists, no-access,
 * no-space, path-too-long, auth, host-key, unreachable, unsupported, unsafe-repo, aborted.
 */
async function cloneRepo({ source, parent, name, onProgress, onMade, signal, platform = process.platform } = {})
```

Steps:
1. `nameError(name)` first. Then `parent` must be absolute, and `(await fs.promises.stat(parent))
   .isDirectory()` (else `not-found`, "The folder <display> no longer exists"). Only then
   `target = path.join(parent, name)`.
2. On Windows, a warning (not a refusal) when `target.length > 200`: Git for Windows without
   `core.longpaths` can't check out paths over 260 characters (CONTRIBUTING.md "Tests").
3. `await fs.promises.mkdir(target)`. The `mkdir` errors map to kinds:

   | Error code | Kind | Message |
   |---|---|---|
   | `EEXIST` | `exists` | "A folder named <name> already exists in <parent>" |
   | `EACCES`, `EPERM` | `no-access` | "Pasta Lite can't create folders in <parent>". On Windows it adds: "Windows Security's Controlled folder access may be blocking it: allow Pasta Lite there, or choose another folder." |
   | `EROFS` | `no-access` | "<parent> is on a read-only volume" |
   | `ENOSPC` | `no-space` | "The disk is full" |
   | `ENAMETOOLONG` | `path-too-long` | "The folder path is too long" |

   Then `fs.promises.lstat(target, {bigint: true})` gives `Made`, which is reported at once with
   `onMade(made)`, so the cleanup can find it even if the next step throws.
4. `gitAt(parent, [...CLONE_ARGS, 'clone', '--progress', '--no-recurse-submodules', '--', source, target],
   {signal, onStderr, maxBytes: 16 * 1024 * 1024})` (the new `spawnGit` option, §5.4). `onStderr`
   feeds the parser and forwards frames to `onProgress`, at most one every 100 ms (the latest frame
   wins; a phase change and `done` are always sent).
5. On success, the post-steps run with **`signal: null`**, so a cancel that lands now can't fail
   (and so delete) a complete clone:
   - `.gitmodules` at the root (`fs.promises.access`) → `submodules: true`
   - `rev-parse --verify -q HEAD` failing → `empty: true`
   - then resolve `{status: 'done', root: target, name, submodules, empty}`
6. On failure, in this order:
   1. **`err.kind === 'aborted'` (or `signal.aborted`) → reject `aborted` at once.** `spawnGit`
      replaced stderr with "git was cancelled" (`src/git-process.js:557-563`), so nothing else can be
      read from it.
   2. **Checkout failed**: the `checkoutFailed` rule matches the parser's `lines()`, and
      `target/.git` exists → resolve `{status: 'checkout-failed', root: target, message}` and keep
      the folder (case 19).
   3. **Anything else**: classify (§5.6), set the error's `message` to the parser's `lines()` joined
      and passed through `redactString` (`src/redact.js:82-88`: URL userinfo, token shapes, the home
      folder as `~`), attach `err.made`, and reject. `serializeError` (`src/ipc-errors.js:62-79`)
      sends the message as it is, so this is the one place it is cleaned.
7. Cancel: the runner aborts the signal, and `spawnGit` kills git:
   - POSIX: SIGTERM to the process group, and git removes the files it wrote (case 10)
   - Windows: `taskkill /F` on the tree plus the MSYS kill, and nothing is removed (case 11)

   The op rejects `aborted` as soon as git has exited. **Removal is not part of the op** (§5.5).

`CLONE_ARGS` is a frozen constant in `src/clone.js` (the `-c protocol.*` pairs of §3.1).
`writesIndex` (`src/git-process.js:348-354`) is false for `clone`, so no index.lock release logic
applies.

### 5.4 `spawnGit` gets `onStderr` (C2)

`spawnGit(cwd, args, {…, onStderr})` passes each stderr chunk to `onStderr(chunk)` before `collect`
stores it (`src/git-process.js:542-549`). The call is wrapped in try/catch, so a listener bug never
breaks the command. Nothing else changes, and every other caller passes nothing. `gitAt` and
`exec.run` already pass options through. `test/exec.test.js` gets a case: chunks arrive in order,
the collected stderr is unchanged, and a throwing listener is ignored.

### 5.5 `src/clone-cleanup.js`: removing what we made (C2)

```js
createCleanup({ prefs, log }) -> {
  remove(made) -> Promise<'removed' | 'gone' | 'kept' | 'failed'>   // persisted first, then removed
  running() -> Made[]
  idle() -> Promise<void>
  resume() -> Promise<void>        // at startup: finish clone.json's pendingCleanup entries
}
```
- `remove(made)` first appends `made` to `clone.json` `pendingCleanup`, then removes it:
  1. `lstat(made.abs, {bigint: true})`
  2. still a directory, not a link, same `dev` and `ino` (and `ino !== 0`)? Otherwise it returns
     `kept` and removes nothing
  3. `await fs.promises.rm(made.abs, {recursive: true, force: true, maxRetries: 5, retryDelay: 100})`
  4. finally, drops the entry from `pendingCleanup`

  `rm` is asynchronous (libuv's thread pool), so the main process never blocks, however big the
  partial checkout is. The retries cover Windows files still open for a moment after `taskkill`
  (antivirus, a dying `index-pack`).
- A failed removal is logged and the entry stays pending: the next launch tries again. The page is
  told through the `clone-progress` event `{opId, cleanup: 'failed', leftover: <display>}` ("A
  partial folder was left at …: delete it by hand").
- `resume()` runs once at startup, after `createClonePrefs` (`main.js` `start()`, next to the
  stores, `main.js:492-494`). It re-checks every pending entry's identity before removing it, so a
  folder the user has since recreated at that path is never touched (`kept`, then dropped from the
  list and logged).
- The service refuses a clone into a target that has a removal running (kind `in-progress`,
  `state: 'cleanup'`, "The previous clone's folder is still being removed").

**Quitting while a removal runs.** The removal is no write in the runner, so `quitFlow.needsConfirm`
(`src/quit-guard.js:95`) doesn't count it, and quitting is never held up by it. It is already in
`clone.json`, so whatever is left when the process exits is finished at the next launch. The quit
guard's `RUNNING` question for a running clone (the op itself) gets clone wording (§6.6), so the
user knows a cancelled clone's folder may be removed at the next start. A clone whose git outlives
the 5 s bound (`BOUND_MS`, `src/quit-guard.js:19,76`) still gets the `UNSAFE` question. That
question's detail is about restoring files (`:198-205`), so §6.6 gives it a per-op wording.

### 5.6 Errors and kinds

New `RULES` in `src/git-errors.js` (matched against the parser's `lines()`, anchored like the `auth`
rule):

| Rule | Pattern | Kind |
|---|---|---|
| `remoteNotFound` | `^fatal: repository '.*' (?:not found\|does not exist)$`m, `^ERROR: Repository not found`m, `^remote: Repository not found`m | `not-found` |
| `hostKey` | `^Host key verification failed`m, `^No .* host key is known for`m | `host-key` (new) |
| `unreachable` | `^fatal: unable to access '.*': (?:Could not resolve host\|Failed to connect\|Connection timed out\|Couldn't connect\|SSL)`m, `^ssh: Could not resolve hostname`m, `^ssh: connect to host .* (?:Connection refused\|Operation timed out\|Network is unreachable)`m | `unreachable` (new) |
| `transportNotAllowed` | `^fatal: transport '[^']+' not allowed`m | `unsupported` |
| `destinationExists` | `already exists and is not an empty directory` | `exists` (new; normally caught by `mkdir` first) |
| `noSpace` | `No space left on device` | `no-space` (new) |
| `dubiousOwnership` (existing, `src/git-errors.js:76`) | `dubious ownership` | `unsafe-repo` |
| `checkoutFailed` | `^warning: Clone succeeded, but checkout failed`m | none (a result, §5.3) |

Order: `aborted` (kind already set) → `checkoutFailed` → `auth` (existing) → `hostKey` →
`remoteNotFound` → `unreachable` → `dubiousOwnership` → `transportNotAllowed` → `noSpace` →
`destinationExists`. `dubiousOwnership` is a `from: 'message'` rule. For clone it is tested against
the joined `lines()`, which is what the message becomes.

ssh prints `fatal: Could not read from remote repository.` after every ssh failure, so that line is
never matched on its own: the line before it decides. If nothing matches, the error has no kind,
and the dialog shows git's cleaned text with the "See Help → Show Logs" hint, as
`isUnexpectedError` does (`renderer/components.js:213`).

`src/error-kinds.js` additions (`test/error-kinds.test.js` requires each one to be set somewhere in
`src/`):

| Kind | Meaning |
|---|---|
| `exists` | the folder to create already exists |
| `unreachable` | the remote could not be reached (DNS, connection, TLS) |
| `host-key` | ssh doesn't know the remote's host key and can't ask (no terminal) |
| `no-access` | the folder can't be written (permissions, a read-only volume, Windows Controlled folder access) |
| `no-space` | the disk is full |
| `path-too-long` | a path is longer than the file system allows |
| `not-found` (changed) | the branch, folder or remote repository doesn't exist |

All of these are expected kinds (`EXPECTED_KINDS`, `renderer/components.js:203-207`): they toast or
show at info level, not as unexpected errors.

### 5.7 Tests (C1, C2)

- **`test/clone-url.test.js`**: tables of URLs per kind, with `platform` passed explicitly (`win32`
  and `darwin`).
  - Accepted: `https://github.com/o/r.git`, `git@github.com:o/r.git`, `ssh://git@host:2222/o/r`,
    `git://h/r`, `https://bob@bitbucket.org/o/r.git` (note), `http://h/r` (note).
  - Refused local sources, on both platforms: `file:///srv/r.git`, `file://host/share/r`,
    `FILE:///x`, `/srv/r.git`, `~/r`, `C:\r\x.git`, `C:/r/x`, `C:repo`, `\\srv\share\r.git`,
    `//srv/share/r`, `\\?\C:\r`, `\\.\pipe\x`, `./r`, `r.git`.
  - Other refusals:
    - argument injection: `-oProxyCommand=x:y`, `ssh://-x/y`
    - helpers and schemes: `ext::sh -c x`, `fd::3`, `hg::https://x`, `codecommit://r`
    - userinfo: `https://u:p@h/r`, `https://ghp_…@github.com/o/r`, `https://hf_…@h/r`,
      `https://<52 chars>@dev.azure.com/…`, `https://<40 hex>@gitea/…`
    - query and fragment: `https://h/r?private_token=x`, `https://h/r#x`
    - text: a control character, a bidi control, 2,049 characters
  - `deriveName`: `r.git` → `r`, `…/r/` → `r`, `…/r/.git` → `r`, `host:o/r.git` → `r`,
    `https://h:8443/` → `h`, `x.bundle` → `x`, `https://h/a%20b` → `a%20b` (no decoding, as git).
    `\` separates too (`C:\a\b.git` → `b`).
  - `nameError` for each rule, per platform.
- **`test/path-names.test.js`** and **`test/display-text.test.js`**: the moved rules. The existing
  worktree-fs and renderer cases keep passing through the re-imports.
- **`test/clone-progress.test.js`**:
  - fixtures: the verified stderr of §3.2 cases 5 and 8 (captured bytes, `\r` frames included), and
    a small-transfer fixture whose frames use `bytes` and `bytes/s` units
  - chunks split at every byte offset, including multi-byte characters across a split
  - `\r\n` endings (Windows)
  - unknown `remote:` lines kept in `lines()` and never parsed as progress
  - the ring and line caps, and `INVISIBLE` characters stripped
- **`test/clone.test.js`** (real git, `test/helpers.js` fixtures). It calls `cloneRepo` directly,
  so it may use local paths and `file://` sources, built with `pathToFileURL(remote).href` so
  Windows paths work.
  - **Success**:
    - a clone of `repoWithRemote().remote` over `file://`: the files, `origin` pointing at the
      source, progress frames with `Receiving objects` reaching 100%, and `done`
    - a local path: success with no transfer frames (case 4)
    - an empty bare repo: `empty: true`
    - `.gitmodules` at the root: `submodules: true`, and no submodule folder populated
  - **`checkout-failed`**: a bare repo built with `git mktree` holding a 300-byte file name (case
    19). This fails on every OS (ENAMETOOLONG, or MAX_PATH on Windows). Expected: status
    `checkout-failed`, `.git` kept, exit 128 confirmed.
  - **Failures**, each with the target gone afterwards:
    - `exists`: the target is a file, an empty folder, or a folder with content, and nothing in
      any of them is touched
    - `no-access`: a parent chmod 0555 (POSIX only)
    - `not-found`: a missing local path and a missing `file://` repo
    - `auth`: the local 401 server of `test/git.test.js:643-660`, reused
    - `unsupported`: running git with only `CLONE_ARGS` and `fd::3` returns git's refusal at once
      (case 12, no hang)
  - **Cancel while connecting**: an HTTP server that accepts and never answers. Abort once `onMade`
    has fired. Expected: kind `aborted`, `err.made` set, no git child left (`killChildren()`
    returns 0). The cleanup tests below remove the folder.
  - **Cancel during "Updating files"**: a `file://` repo with ~20,000 small files, so the checkout
    takes over a second and prints `Updating files`. Abort on its first frame. Expected: `aborted`
    (not `checkout-failed`, despite git's checkout error), then the removal leaves no folder.
  - **Late cancel**: abort right after git exits 0 (a test hook between the git call and the
    post-steps). Expected: the clone resolves `done` and nothing is removed (L7).
  - **Redaction**: an error whose stderr contains `https://u:tok@h` and the home folder gives a
    message with `***@` and `~`.
  - **Enclosing repo**: a parent inside another repository with `url.*.insteadOf` in its config →
    not applied (case 18).
- **`test/clone-cleanup.test.js`**:
  - removal of a real partial clone, persisted first and dropped from `pendingCleanup` after
  - the target replaced by a symlink (POSIX) or by a different directory before removal → `kept`,
    nothing removed
  - `resume()` at "startup" removes a pending entry whose identity matches, and keeps one that
    doesn't
  - **a removal that outlasts the quit bound**: `rm` faked to take longer than `BOUND_MS`. The quit
    guard returns `quit` without an `UNSAFE` question (the removal is no runner op), the entry is
    still in `clone.json`, and a fresh `resume()` finishes it
  - **Windows only** (`skip` otherwise, like `test/windows-defaults.test.js`): cancel a real clone
    after the first frame. `taskkill /F` leaves files (case 11). The removal must also delete the
    read-only pack files and the hidden `.git` (Git for Windows' `core.hideDotFiles`). Paths stay
    short (CONTRIBUTING.md)
- **`test/git-errors.test.js`**: each new rule against captured lines, and against hook-like text
  in stdout that must not match.

---

## 6. Main process and IPC (C3)

### 6.1 The app op in the runner

`src/ops.js` gets an `APP` registry next to `READ` / `WRITE`:

```js
// App-level ops: no tab repository (the IPC 'op' channel can't reach them: ops.OPS doesn't list
// them). The runner's `repo` key is the op's own folder (clone: the target), for the write queue
// and the log record; act gets it first, as every op's act does.
const APP = {
  clone: write(op(cloneCheck, (target, req, hooks, signal) => cloneRepo({ ...req, ...hooks, signal })), { bare: true }),
};
```

- `ops.createRunner` passes `ops: {...OPS, ...APP_RUN}` and `writeOps` including `clone`. The gate
  looks a descriptor up with `DESCRIPTORS[name] || APP_DESCRIPTORS[name]`. With `bare: true` and no
  `mirror`, `bareGate` (`src/bare-gate.js:44-51`) returns null without calling `isBare` on a folder
  that doesn't exist yet.
- `DESCRIPTORS`, `OPS`, `WORKTREE_OPS` and `BARE_OK` stay exactly as they are (`src/ops.js:741-761`),
  so `test/bare.test.js` and `test/ipc-contract.test.js` don't change for them.
- `cloneCheck(target, req, hooks)` re-runs `nameError`, and `parseCloneUrl` for a typed source. It
  picks `{source, parent, name}` explicitly. `hooks` is `{onProgress, onMade}`: main-side functions,
  never from the page.
- What clone gets for free:
  - the write queue, keyed by the target: two clones to the same target run one after the other,
    and the second gets `exists`
  - `busy` / `changed` events, which the pages and watchers ignore for a repo they don't hold
    (`src/watch-session.js:114-123`, `renderer/app.js:188,207`)
  - `runner.running({owner})` for the tab strip's busy state (`main/tabs-controller.js:58`)
  - the quit guard and the tab close guard (`src/quit-guard.js:48-124`)
  - cancellation through `app:cancel` (`main/ipc.js:148`, `ownedOpId`)
- `worktreeVet` (`src/ops.js:451-466`) only does real work while a worktree is being deleted, and a
  missing target path is harmless there (`realPathOf` answers `missing`).

### 6.2 `src/clone-service.js` (Electron-free use cases)

```js
createCloneService({ runner, opening, prefs, cleanup, pickFolder, home, log })
  -> {
    defaults(session) -> {parent: {display, chars}, running: {opId, target} | null, last}
    pickParent(session) -> {display, chars} | null
    cancelPending(session, opId) -> boolean
    clone(session, {url, name, parent}, opId) -> CloneOutcome
    openCloned(session, opId) -> {opened: RepoInfo | null, reason?}
  }
CloneOutcome = {status: 'done' | 'checkout-failed', target: display, submodules, empty,
                opened: RepoInfo | null, reason?: 'declined' | 'stale' | 'closed', openError?, message?}
```

- **Parent**: `prefs.lastParent()` (a stored path that is still a directory), else `home()`.
  - `pickParent` shows main's folder dialog (`properties: ['openDirectory', 'createDirectory']`,
    `defaultPath`: the current parent, title "Choose where to clone"), the same way `pickFolder` does
    (`main.js:249-253`). A chosen folder is saved **at once** as `lastParent`: the last folder the
    user chose is the last used one.
  - `clone` takes `parent: <display the page showed>`. If main's current parent's display differs
    (another tab picked another folder meanwhile), it refuses with kind `stale` ("The folder
    changed; check it and try again"). No per-tab parent state is kept.
- **Source**: the typed URL, checked again with `parseCloneUrl`. There is no local source (§15).
- **Running clones**: a `Map(session.id → {opId, target display})` while a clone runs, used three
  ways:
  - `in-progress` (`state: 'clone'`) refuses a second clone from the same tab
  - `defaults` reports `running`, so a page that reloaded or crashed reattaches to its progress and
    its Cancel (M10)
  - entries are dropped when the op settles
- **`clone()`**:
  - Runs `runner.run(target, 'clone', [{source, parent, name}, {onProgress, onMade}],
    {opId: ownedOpId(session.id, opId), owner: session.id})`.
  - `onProgress` sends `EVENTS.CLONE_PROGRESS` `{opId, ...frame}` to that session only
    (`session.send`, which is silent once the tab closed: `src/tab-session.js`).
  - On rejection with `err.made`: `cleanup.remove(err.made)` starts (not awaited by the reply), and
    its failure later reaches the page as a `cleanup: 'failed'` event.
  - On `done`: open it (§6.4).
  - On `checkout-failed`: keep `{opId → target}` in a single-entry slot for `openCloned`, and resolve.
- **`openCloned(session, opId)`** opens the slot's target if `opId` matches (else `not-found`), then
  clears the slot. It backs `app:openCloned`, the dialog's **Open Anyway**. It exists because the
  page can't send the path, and main must not open a half-checked-out repository without the user's
  choice (its status would show every missing file as deleted). The slot is one entry, overwritten
  by the next `checkout-failed`; there is no per-session state.

### 6.3 IPC contract additions (four channels)

`src/ipc-contract.js` `CHANNELS` gets four channels, all `from: ['view']` and none `needsRepo`, so a
start-screen tab can call them:

| Channel | Args (coercers) | Handler |
|---|---|---|
| `app:cloneDefaults` | none | `clone.defaults(session)` |
| `app:pickCloneParent` | none | `clone.pickParent(session)` |
| `app:clone` | `cloneRequest`, `opId` | `clone.clone(session, req, opId)` |
| `app:openCloned` | `opId` | `clone.openCloned(session, opId)` |

New coercer (next to `openOptions`, `src/ipc-contract.js:35-62`), `cloneRequest(v)`:
- an object with `url` (a string of at most `MAX_URL`: the typed URL), `name` (a string of at most
  255 UTF-16 units with no NUL) and `parent` (a string of at most 4,096: the display the page showed)
- nothing else is picked, and extra fields are dropped, never spread
- its refusal messages never quote the values: `main/ipc.js:84` logs coercer refusals with the
  error, and a URL must not reach the log

`app:clone`'s `opId` uses the existing `opId` coercer (required here: a clone is always
cancellable).

`EVENTS.CLONE_PROGRESS = 'clone-progress'`: `{opId, phase, percent, current, total, bytes, rate,
done}`, or `{opId, cleanup: 'failed', leftover}`, sent to one tab. `MENU_COMMANDS.CLONE = 'clone'`.
`preload.js` `EVENTS` (line 12) gets `'clone-progress'` (`test/ipc-contract.test.js:44` checks the
two lists agree).

**Logging**: `main/ipc.js:90` logs handler failures with the full error for every channel except
`op`. It becomes a set, `QUIET = new Set(['op', 'app:clone'])`. For those two the runner already
logs the op (`logError`: `{name, kind, code, exitCode}`). Failures that come from the service before
the runner (`stale`, `in-progress`) are logged by the service with `logError` too.

`preload.js`, `window.api.clone`:
```js
clone: {
  defaults: () => call('app:cloneDefaults'),
  pickParent: () => call('app:pickCloneParent'),
  start: (opId, req) => call('app:clone', { url: String(req.url), name: String(req.name), parent: String(req.parent) }, String(opId)),
  openCloned: (opId) => call('app:openCloned', String(opId)),
},
```
Cancel is the existing `window.api.app.cancel(opId)`, and the opId comes from `api.newOpId()`.
`preload-tabs.js` doesn't change (the strip gets the busy state through `tabs-changed`).

`main/ipc.js` `createHandlers` gets the clone service as a dependency (`main.js:293-296`).
`test/ipc-contract.test.js` adds: the channels are view-only; the coercer (bad types, extra fields
dropped, a long URL refused, no value in the message); a strip sender is refused.

### 6.4 Opening the clone (`src/repo-opening.js`)

**Open with a reason.** Today `open()` returns null in three different situations:
- a newer open won, or the tab closed (`stale()`, `src/repo-opening.js:113`, `:130`;
  `src/tab-session.js:105-108` makes the token stale on close)
- the user declined Trust and Open (`:123`)
- a restore was aborted

The body moves into `attempt(dir, o)`, which resolves `{info, session}` or
`{info: null, reason: 'declined' | 'stale' | 'closed' | 'aborted'}`. `'closed'` means
`from.closed`; `'stale'` means the token was superseded while the tab is alive. `open()` stays a thin
wrapper that maps a reason to null, so no existing caller changes (`restoreTabs`'s `if (res)`,
`main/tabs-controller.js:287-291`).

New use case:
```js
/** A repository main just cloned for tab `session` (`dir` is main's own target path, never a page's). */
openCloned: (session, dir) => attempt(dir, { from: session, newTab: !!session.repo }),
```
- From a start-screen tab, the repo replaces it, like `openFromDialog`. From a tab with a repo open
  (File > Clone… while a repo is shown), it opens in a new tab next to it
  (`src/repo-opening.js:135-137`).
- `attempt()` does the rest: `ops.openRepo`, the trust check (`src/repo-trust.js`; a fresh clone has
  only `*.sample` hooks and no risky config, so normally no prompt), `recent().add`, `REPO_OPENED`,
  `RECENT_CHANGED` to the other tabs, the menu rebuilt (`onOpened`), activate and bring to front.

What the service does with each outcome:

| Outcome | Service | Page |
|---|---|---|
| `{info}` | done | the repo view appears |
| `reason: 'declined'` | nothing more: no second attempt, so no second question | notice "Cloned to <target>. It was not opened." |
| `reason: 'stale'` (the tab is alive; a newer open landed in it, e.g. from the toolbar picker of a repo tab with the clone dialog dismissed) | one more `attempt(dir, {from: session, newTab: true})`, so the clone opens next to it | the new tab is shown |
| `reason: 'closed'` | **does not open.** `recent().add(target)` (best effort), `onRecentChanged()` (the menu and the other tabs), and a log record | (no page) |
| `ops.openRepo` throws (e.g. `unsafe-repo`: dubious ownership on a network or FAT drive) | resolves `{status: 'done', opened: null, openError: serializeError(e)}`: the clone itself succeeded | "Cloned to <target>, but it couldn't be opened: <message>" |

**The closed-tab policy** (H3, decided): when the session that started a clone closes, the clone
**keeps running to completion and is not opened**. It is added to the recent list and logged.
- **Why.** Closing a tab explicitly already asks first: its close guard counts the clone as a write
  and offers "Cancel and Close" (`main/tabs-controller.js:219-241`). Closing the window on
  Windows / Linux quits, and the quit guard asks. The only close that doesn't ask is macOS's window
  close (`main.js:199`: `isMac && ui.interactive` skips the quit flow). There, `destroyAll` closes
  every session without cancelling its ops (`main/tabs-controller.js:197-212`), as it does for a
  push today. Letting the clone finish keeps the user's download, like the push.
- **Why it isn't opened.** A fallback `open(…, {newTab: true})` would call `addTab`, which creates a
  window when there is none (`main/tabs-controller.js:163`), so a window would pop up minutes after
  the user closed it. The recent list makes the repository one click away instead (the start screen,
  ⌘P, File > Open Recent).
- **The rejected option, cancelling on close**, would throw away a long download on the one close
  path that never asked, and would need `destroyAll` to treat clone differently from every other
  write.

The header comment's security boundary list gets one more source: "a folder main itself just cloned
into (src/clone-service.js)".

### 6.5 Prefs: `createClonePrefs` in `src/recent.js`

`userData/clone.json`, `{lastParent: <abs>, pendingCleanup: [{abs, dev, ino}]}`, read with
`fs.promises.readFile` and written through `src/json-file.js` (atomic write; Windows rename
retries). `json-file.js`'s `writeJson` is synchronous today (`renameSync` with a blocking
`sleepSync` retry), so C3 adds an async `writeJsonAsync` beside it (`fs.promises.writeFile` +
`rename` with the same retry codes, waiting with timers). `createClonePrefs` uses only the async
pair.
- `lastParent()` resolves null unless the value is an absolute path that is still a directory.
- `setLastParent(abs)` and the `pendingCleanup` edits are best effort: a failure is logged, never
  fails the clone.

Created in `main.js` `start()` next to `recent` (`main.js:492-494`), followed by
`cleanup.resume()` (not awaited before the window appears).

### 6.6 Quit and close wording (`src/quit-guard.js`)

`dialogOptions(kind, names)` (`src/quit-guard.js:175-207`) words three questions; clone needs two
of them adjusted:
- **`RUNNING` / `CLOSE` with a clone among the names**: the detail gets a second sentence, "A
  clone that is cancelled leaves no folder behind: its partial folder is removed, at the next start
  if needed."
- **`UNSAFE`**: today the detail is about restoring files, which is only true of undo's reversal and
  a discard's backup record (`:198-205`). It becomes a per-op table: undo / discard keep today's
  text; for clone (git ignoring its kill), "Git is still stopping. Quitting now leaves a partial
  folder, which is removed the next time Pasta Lite starts."

The wording is chosen from the op names `run()` already collects (`opNames`, `src/quit-guard.js:32`).
`test/quit-guard.test.js` covers both.

### 6.7 Menu and keyboard

- `main/menu.js` File menu, after "Open Repository in New Tab…" (`main/menu.js:54-55`):
  `{ label: 'Clone Repository…', accelerator: 'CmdOrCtrl+Shift+N', click: () => controller.commandToActive(MENU_COMMANDS.CLONE) }`.
- `controller.commandToActive(id)` (new, `main/tabs-controller.js`) picks the active tab, or adds a
  new tab when there is none (macOS with no window: `addTab` creates the window, which the user just
  asked for). It waits for `s.loaded` and sends `EVENTS.MENU_COMMAND {id}`. Today Reset Column
  Widths sends only when there is an active tab (`main/menu.js:78`).
- **⇧⌘N / Ctrl+Shift+N**, decided (§13 Q1). It collides with nothing: it is not in `KEYS`
  (`renderer/keys.js:41-53`), not a `VIEW_KEYS` key (those take no modifier,
  `renderer/keys.js:81-84`), and not a main accelerator (⌘T, ⌘W, ⇧⌘O, ⇧⌘W, ⌘1–9, ⌘⇧[ / ], Ctrl+Tab;
  `main/menu.js`). It leaves ⌘N for "New Repository…" (Init, roadmap P3b). Like ⇧⌘O and ⌘T it is a
  main accelerator and stays out of `KEYS` (the rule in `keys.js:36-39`). The start screen shows its
  hint with `keyHint({key: 'n', shift: true})`, as it shows ⌘T today
  (`renderer/components/repo-picker.js:540-541`).

---

## 7. UX and renderer (C4)

### 7.1 Entry points

| Where | What |
|---|---|
| File > Clone Repository… (⇧⌘N) | `menu-command {id: 'clone'}` → `PLClone.open()` in the active tab, or a new tab if there is none. Ignored while a page dialog or menu is open (`modalOpen()`, `renderer/components.js:186-191`), like the global keys (`renderer/app.js:144,154`) |
| Start screen (`mountStart`, `repo-picker.js:513-549`) | a **Clone…** button next to **Open…** in `.start-actions`, with the ⇧⌘N hint. The subtitle becomes "Pick a recently opened repository, open a folder, or clone one." |
| Repository picker footer (`createList`'s footer, `repo-picker.js:240-258`) | **Clone…** next to Open… and View all. It closes the popover, then opens the dialog |
| Tab strip "+" | nothing new: it opens a New Tab, whose start screen has Clone… |

### 7.2 The dialog: three chained modals

**1. The form**
```
┌ Clone a repository ───────────────────────────────────────────────┐
│ Repository URL                                                    │
│ [ https://github.com/org/repo.git                              ]  │
│   ⓘ http:// isn't encrypted                       (notes, if any) │
│ Clone into                                                        │
│ [ ~/code                                        ] [ Choose… ]     │
│ Folder name                                                       │
│ [ repo                                          ]                 │
│   Will create ~/code/repo                                         │
│                                          [ Cancel ]  [ Clone ]    │
└───────────────────────────────────────────────────────────────────┘
```
- **URL field**: focused first. There is no paste-from-clipboard prefill, because the pages deny
  every permission (`main.js:488-491`). It is validated on every edit with
  `PLCloneUrl.parseCloneUrl`, and the error shows inline (`dlg-error`, as `prompt` does,
  `renderer/dialog.js:160-181`). A typed local path gets the message "Enter a remote URL
  (https://…, ssh://…, git@host:…)": clone is for remotes only.
- **Folder name**: follows `deriveName(url)` until the user edits it, then stays as typed. A "touched" flag tracks that, like `editMessage`'s
  (`dialog.js:250-268`). The name is checked with `nameError` only: a folder that already exists is
  reported by the clone itself (`exists`, from `mkdir`), with no extra round trip.
- **Clone into**: read-only text showing main's display, with **Choose…**
  (`api.clone.pickParent()`).
- **Clone** is disabled while any field has an error. Enter in a field = Clone. Esc = Cancel.

**2. Progress** (opened on submit: `opId = api.newOpId()`, `api.clone.start(opId, {...})`)
```
│ Cloning github.com/org/repo into ~/code/repo                      │
│ Receiving objects   45%   (1,234 / 2,741) · 12.3 MiB · 4.1 MiB/s  │
│ [██████████████░░░░░░░░░░░░░░░░░░]                                │
│                                                       [ Cancel ]  │
```
- One `<progress>` bar for the current phase (`max = 100`). It is indeterminate before the first
  percent and for phases without one.
- Phase labels are git's (Receiving objects, Resolving deltas, Updating files, Filtering content),
  and `remote:` phases read "Server: counting objects".
- The text goes in an `aria-live="polite"` line, updated at most once a second for screen readers.
- **Waiting.** After 30 s without a progress frame, the page itself shows "Waiting…"; there is no
  event from main. With no frame yet, it adds the auth hint: "If the server needs a
  password or an SSH key passphrase, Pasta Lite can't ask for it yet," followed by `authMessage`
  (`renderer/flows-kit.js:222-224`, made public as `PLFlowKit.authMessage`).
- **Only the Cancel button cancels** (L6). While the clone runs, Esc and backdrop clicks are ignored
  (the modal's `onDismiss` veto, §7.3). Cancel calls `api.app.cancel(opId)`, then shows
  "Cancelling…" disabled until `app:clone` settles with `aborted`. The dialog then closes with the
  notice "Clone cancelled". There is no confirmation: cancelling destroys nothing of the user's.
- **A forced close.** If another dialog forces this one shut ("One dialog at a time: opening another
  cancels the first", `renderer/dialog.js:21-22,45`), the clone is **not** cancelled. It keeps
  running, its outcome is shown as a toast (success: the repo opens anyway), and the tab's busy
  indicator still shows it.
- **Reattaching.** On load, `PLClone.resume()` asks `api.clone.defaults()`. When `running` is set
  (the page reloaded or crashed mid-clone; the tab session survived), it reopens the progress modal
  for that `opId` and target. Frames continue, Cancel works, and the outcome arrives as the
  `repo-opened` event or a toast.

**3. The outcome** (only when there is something to say)
- `done` + `opened` → no modal: the repo view appears (this tab or a new one). Notices:
  "Cloned <name>", plus "It has submodules, which were not cloned: run `git submodule update
  --init` in a terminal" when `submodules`. An `empty` repo needs nothing extra: the repo view shows
  the unborn state.
- `done` + `reason: 'declined'` → notice "Cloned to <target>. It was not opened."
- `done` + `openError` → alert "Cloned to <target>, but it couldn't be opened", with the message.
- `checkout-failed` → "The repository was cloned, but some files could not be checked out", with
  git's text (e.g. "File name too long") and **Open Anyway** / **Close**. Open Anyway calls
  `api.clone.openCloned(opId)`.
- An error → its explanation, with **Back** (reopens the form with its values) and **Close**:

| Kind | Title / message |
|---|---|
| `auth` | "Authentication failed" + `authMessage` (the credential helper per platform, ssh-agent) |
| `host-key` | "Unknown host key": "ssh doesn't know <host> yet and can't ask here. Connect once from a terminal (`ssh -T <user@host>`) to check and accept its key, then try again." |
| `not-found` | "Repository not found": "Check the URL. For a private repository this can also mean you aren't signed in (many hosts answer 'not found' instead of 'forbidden')." |
| `unreachable` | "Can't reach the server": git's line (DNS, connection, TLS) |
| `exists` | "Folder already exists": choose another name or folder |
| `no-access` / `no-space` / `path-too-long` | the `mkdir` message of §5.3, or git's text |
| `unsafe-repo` | git's dubious-ownership text |
| `unsupported` | "This kind of URL isn't supported" (a URL the user's own `insteadOf` rewrote to a helper transport) |
| `stale` | "The folder changed (another tab chose a different one). Check it and try again." Back reopens the form with main's current values |
| `in-progress` | "A clone is already running in this tab" / "The previous clone's folder is still being removed" |
| `aborted` | no modal; the notice "Clone cancelled" |
| none | git's cleaned text, with "See Help → Show Logs for details" |

A later `cleanup: 'failed'` event shows the toast "A partial folder was left at <leftover>: delete
it by hand."

### 7.3 Where the code lives

- **`renderer/dialog.js`**: `modal` (`dialog.js:44-114`) gets one new option, `onDismiss()`. It is
  called on Esc (`:83`) and on a backdrop press (`:107`), and returning false keeps the dialog open.
  A forced close (another dialog opening) still closes it. `modal` is exported on
  `Components.dialog` as it is, with no new wrapper. The existing focus trap (`:68`, `:95-103`)
  already covers the extra fields and buttons the clone form passes. `confirm`, `prompt` and the
  others don't change. The roadmap's `dialog.form({fields})` (roadmap.md:528-529) remains future
  work, and the clone form can move onto it.
- **`renderer/clone.js`** (`window.PLClone`; also `module.exports` for the tests), loaded after
  `components/repo-picker.js` and before `app.js`:
  - `open({onError})` chains the three modals (form → progress → outcome) and is the whole flow.
    It needs no store and no repo: like `PLRepoPicker.openFolder`, it is an app-level action, not a
    `PLFlows` flow (`flow()` returns false without a repo, `renderer/flows-kit.js:113`).
  - `resume()` reattaches to a running clone (§7.2).
  - Pure helpers under `_internal`, unit-tested without the DOM: `progressText(frame)`,
    `formatRate`, `errorView(err)`, `nameState(touched, source, name)`.
  - It subscribes to `clone-progress` while a clone runs, and ignores frames for another opId.
- **`renderer/app.js`**:
  - `menu-command` `clone` → `PLClone.open({onError: toast})`, next to `resetColumnWidths`
    (`app.js:204-206`), skipped when `modalOpen()`
  - `PLClone.resume()` after `getState` (`app.js:214-225`)
- **`renderer/components/repo-picker.js`**: the two buttons. The `onFolder` pattern is reused as
  `onClone`, so the popover closes first.
- **`renderer/components.js`**: `displayName` and `INVISIBLE` now come from `src/display-text.js`
  via `load()`.
- **`renderer/clone.css`** (linked in `index.html`): field rows and the progress bar, using the
  existing tokens (`--panel`, `--border`, `--text-2`, an accent).
- **`renderer/index.html`**: `<script>` tags for `../src/display-text.js`, `../src/path-names.js`
  and `../src/clone-url.js` after `../src/error-kinds.js` (before `components.js`, which loads the
  first); `clone.js` after `components/repo-picker.js`. No CSP change.
- **`eslint.config.js`**: the three `src/` files in the renderer files block (line 50), and
  `PLClone`, `PLCloneUrl`, `PLPathNames`, `PLDisplayText` in `RENDERER_GLOBALS`.
- **`test/renderer-harness.js`**: loads the `src/` scripts and `clone.js`; `api.clone` is faked.

### 7.4 Where the state lives

| State | Owner | Lifetime |
|---|---|---|
| The parent folder | main: `clone.json` `lastParent` (else home); the page holds its display to send back | across launches |
| URL, name, touched flag | the form (DOM fields), passed to Back | the dialog |
| The running clone | the runner and the service's per-session entry (`opId`, target display); the page's progress modal | until settled; survives a page reload |
| Progress | events → the progress modal only (never `Store`: a start-screen tab has no store state, and nothing else needs it) | until settled |
| A checkout-failed target | main: one service slot, keyed by opId | until opened or replaced |
| Pending removals | main: `clone.json` `pendingCleanup` | until removed, across launches |

No `localStorage` is used: the last URL is not remembered (it may carry a user name, and a fresh
dialog is the expected behaviour).

---

## 8. Security

| Threat | Mitigation |
|---|---|
| The page names a folder to write into | It can't: the parent is main's (native dialog, stored preference, home), and the page sends one segment, which main checks with `nameError` (§4.3). The page only echoes main's display, for the `stale` check |
| **The page names a local repository to read** (clone a private repo, then open and read it) | There is no local source: local paths, `file://` with any host, UNC, `\\?\` / `\\.\` device paths, drive-relative `C:repo` are refused (§5.1 step 2), and the main side has no other way in (remotes only, §15) |
| NTLM hash leak through a UNC source (Windows) | UNC and `//server/share` are refused |
| Argument injection through the URL | validated before git (a leading `-`, a host starting with `-`, `INVISIBLE` characters); always after `--`; git itself also blocks `-`-prefixed hosts and paths (§3.2 case 16) |
| Command-running transports (`ext::`, `fd::`, `<helper>::`, an `insteadOf` rewrite to one) | refused by `parseCloneUrl`; `-c protocol.allow=never` with five allowed transports on the command line, which beats every config file; `protocol.ext.allow=never` is already in `GLOBAL_ARGS` |
| Weakening git's submodule hardening (CVE-2022-39253) | `protocol.file.allow` stays `user`: our `-c` values reach child gits through `GIT_CONFIG_PARAMETERS`, and `always` would let a submodule clone use `file`. Also `--no-recurse-submodules`. The local-clone symlink fix itself is in git ≥ 2.38.1, and the app requires 2.51 (`src/gitcheck.js:14`) |
| A hostile repository runs code at clone time | no hooks travel with a clone; filter drivers can only come from the user's own config; `core.fsmonitor=false` (`GLOBAL_ARGS`); opening goes through the trust check (`src/repo-trust.js`), as for any open |
| A hostile repository redirects Git LFS (`.lfsconfig` `lfs.url`) | **accepted, outside our control**: git-lfs's own HTTP client ignores `protocol.*.allow`, so smudge requests (with whatever credentials the user's helper gives that host) can go to a host the repository names (§3.3). It only happens for users who installed git-lfs globally, and a terminal clone does the same. SECURITY.md says so |
| **A renderer-chosen network destination** | **accepted risk.** Everywhere else a page can only make git contact remotes already in a repo's config (`fetch` / `push` take only configured remote names, `src/ops.js:530-554`, `remoteName` in `src/op-validators.js:105-109`), and the CSP blocks the page's own network access (`default-src 'none'`, `renderer/index.html:5`). Clone is the one place a compromised page can make git connect to a host it chooses (https, http, ssh, git), and a URL or DNS name can carry data the page already has. This is the feature itself, and it only matters once the renderer is compromised. The limits: five transports, no helpers, no local sources, no credentials in the URL. SECURITY.md's scope section gets a note |
| Path traversal / Windows aliases in the name | one segment only; `.`, `..`, `.git` aliases (`GIT~1`, trailing dots or spaces), device names and `<>:"\|?*` refused (`src/path-names.js`) |
| Deleting something that isn't ours | only the folder we created, after an identity check right before removal (§4.3), again at the next launch; no cleanup for a target we couldn't create |
| Credentials in logs | `summarizeArgs` counts everything after `--` (the source and target are never in a git command record); `app:clone` and the runner's op record log only `{name, kind, code, exitCode}` (`logError`, `src/ipc-errors.js:87-94`; §6.3); coercer refusals never quote values; the logger redacts every record (`src/log.js`) |
| Credentials in the UI and `.git/config` | passwords, token-shaped or unusual user names, `?` and `#` refused in http(s); error messages go through `redactString` |
| Server-controlled text (`remote:` lines) | only picks between messages (`not-found`, `auth`, §5.2); `INVISIBLE` characters stripped; `textContent` only |
| A clone that hangs | Cancel at any time (signal → process-group / tree kill); the "Waiting…" notice; the quit guard asks, then kills |
| The shell | none: `spawn` with an argv (`src/git-process.js:504`) |

**SECURITY.md** (C5): one paragraph in "Scope":
- clone accepts typed https, http, ssh and git URLs only (remotes only: no local source) and never
  runs a transport helper
- a page can choose the network host a clone contacts (the accepted risk above)
- Git LFS follows a repository's `.lfsconfig`

---

## 9. Windows

### 9.1 What the existing code already covers

- **Cancel and quit kill the whole process tree**: `taskkill /T /F` plus the MSYS kill by
  `PASTA_LITE_GIT_ID` (`src/git-process.js:216-318`). A hard kill means git's own cleanup never
  runs (case 11), so `src/clone-cleanup.js` is required on Windows, not just a safety net.
- **The rest of the Windows plumbing clone relies on:**
  - no console windows (`windowsHide`)
  - git found in Git for Windows' folders (`src/gitcheck.js`)
  - case-insensitive path comparisons (`src/fs-paths.js`)
  - Windows home redaction (`src/redact.js:56-75`)
  - JSON saves that retry on a briefly locked file (`src/json-file.js`)
- **Git Credential Manager** (Git for Windows' default `credential.helper=manager`) shows its own
  sign-in window. git starts it, and `windowsHide` only hides git's own console
  (`src/git-process.js:502-503`). With no clone timeout, the user has time to sign in.

### 9.2 What clone adds or must check

- **Local sources**: none. Drive paths and UNC / mapped shares are refused when typed (decision 1).
- **Folder names**: the Windows rules (§4.3), applied when `platform === 'win32'`.
- **Long paths**: Git for Windows doesn't enable `core.longpaths`, and neither does the app
  (CONTRIBUTING.md; decided not to change in the MVP, §13 Q4). A deep repository then fails at
  checkout ("Filename too long"), which gives the `checkout-failed` result (decision 7). The form
  warns before starting when the target path itself is over 200 characters.
- **Controlled folder access** (Windows Security) refuses `mkdir` in Documents and similar folders
  for apps it doesn't trust: `EPERM` / `EACCES` → `no-access`, with the hint (§5.3).
- **Cleanup**: read-only pack files and the hidden `.git` (`core.hideDotFiles=dotGitOnly`). Node's
  `fs.promises.rm` handles read-only files on Windows through its internal EPERM fix-up (chmod, then
  retry). This **must be proven by the Windows-only test** in §5.7, with `maxRetries` for files
  still held open after the kill.
- **Line endings**: `core.autocrlf` comes from the user's or Git for Windows' system config, and
  clone doesn't override it. The progress parser accepts `\r\n`.
- **The 32,767-character command line** (`src/git-process.js:618-623`): one URL (at most 2,048
  characters) and one path. No chunking is needed.

### 9.3 The SSH passphrase risk on Windows

On POSIX, git runs with no controlling tty (detached), so ssh fails at once when it needs a
passphrase or a host-key answer. On Windows, git and ssh share a **hidden console**, so an ssh that
decides to prompt may wait on a console nobody can see. Fetch is bounded by its 120 s timeout;
clone isn't. Until we know, the safeguards are the "Waiting…" notice with the auth hint, and Cancel.

**Decided (§13 Q5).** QA row 6 checks whether Git for Windows' bundled OpenSSH (or Windows' own)
prompts on the hidden console or fails. **If it hangs**, BatchMode is applied to **all** remote
ops on Windows (fetch, pull's fetch, push, clone), not only clone:
- git gets `-c core.sshCommand="ssh -o BatchMode=yes"` (in `src/remote.js`'s `remoteOpts` and in
  `CLONE_ARGS`'s Windows variant)
- only when `GIT_SSH`, `GIT_SSH_COMMAND` and `core.sshCommand` are all unset: the env from
  `process.env`, and the config from `git config --get core.sshCommand`, read in the repo for
  fetch / push, and with `--global` for clone
- the user's own ssh setup always wins

The setting goes away once P3a's askpass lands.

---

## 10. Implementation phases (file by file)

### C1: pure core
1. `src/path-names.js` (new): `isDotGitName`, `DEVICE_NAME`, `refusedName`, CommonJS-or-window.
   `src/worktree-fs.js` imports them back. Tests: `test/path-names.test.js`; the worktree-fs cases
   stay unchanged.
2. `src/display-text.js` (new): `INVISIBLE`, `displayName`. `renderer/components.js` loads them
   through `load()`. Tests: `test/display-text.test.js`; `test/renderer-util.test.js` unchanged.
3. `src/clone-url.js` (new): §5.1, with the local-source refusals, the userinfo rules and the
   `?` / `#` rule. Tests: `test/clone-url.test.js`.
4. `src/clone-progress.js` (new): §5.2, accepting the `bytes` units. Tests:
   `test/clone-progress.test.js`, with captured fixtures under `test/fixtures/clone/` (stderr bytes
   of a `file://` clone, an empty-repo clone, and a small transfer with `bytes`).
5. `eslint.config.js` and `renderer/index.html`: the shared files and their globals.

*Done when* `npm test` and `npm run lint` pass, with no behaviour change.

### C2: clone backend
1. `src/git-process.js`: the `onStderr` option (§5.4). Test in `test/exec.test.js`.
2. `src/git-errors.js`: the rules of §5.6. Tests in `test/git-errors.test.js`.
3. `src/error-kinds.js`: `exists`, `unreachable`, `host-key`, `no-access`, `no-space`,
   `path-too-long`; the new `not-found` meaning.
4. `src/ipc-errors.js`: `leftover` in `EXTRA_FIELDS` (`:17-31`).
5. `src/json-file.js`: `readJsonAsync` / `writeJsonAsync` (§6.5).
6. `src/clone.js` (new): `cloneRepo`, `CLONE_ARGS` (with `protocol.file.allow=user`), the `mkdir`
   error mapping, `aborted` first, post-steps with `signal: null`, `maxBytes` 16 MiB.
   Tests: `test/clone.test.js` (§5.7), including `checkout-failed` from `git mktree`, cancel during
   "Updating files", and the late cancel.
7. `src/clone-cleanup.js` (new): §5.5. Tests: `test/clone-cleanup.test.js`, including the Windows-only
   hard-kill test that CI's Windows job runs, and the removal that outlasts the quit bound.

*Done when* clones from `file://` and local sources, a cancel, a checkout failure and every failure
kind pass on macOS, Ubuntu and Windows CI.

### C3: main wiring
1. `src/ops.js`: the `APP` registry, `APP_DESCRIPTORS`, `createRunner` merging them, and the gate
   lookup. Tests in `test/ops.test.js`: clone runs through `runner.run`, it is a write, it cancels
   by opId, and it isn't in `OPS`.
2. `src/recent.js`: `createClonePrefs` (async). Tests in `test/recent.test.js`.
3. `src/repo-opening.js`: `attempt()` with reasons, `open()` as its wrapper, `openCloned`. Tests in
   `test/repo-opening.test.js`:
   - a start-screen tab → the clone opens here
   - a tab with a repo → a new tab
   - `stale` with the tab alive → a new tab
   - `closed` → not opened, no tab or window created, added to recent
   - `declined` → asked once, not opened
   - `openRepo` throwing → `openError`
4. `src/clone-service.js` (new): §6.2. Tests in `test/clone-service.test.js`, with fakes (runner,
   opening, prefs, cleanup, pickFolder) as `test/repo-opening.test.js` does:
   - the default parent (last used, else home) and `stale` on a display mismatch
   - `in-progress` for a second clone, and for a target still being removed
   - progress events to the right session only
   - `defaults().running` after a "reload"
   - the `checkout-failed` hand-off to `openCloned`
   - the window and tab closed mid-clone: the clone finishes, is added to recent, no `addTab`
5. `src/quit-guard.js`: the clone wording (§6.6). Tests in `test/quit-guard.test.js`.
6. `src/ipc-contract.js`: the four channels, the coercer, `CLONE_PROGRESS`, `MENU_COMMANDS.CLONE`.
   `main/ipc.js`: the handlers and the `QUIET` logging set. `preload.js`: `api.clone` and the event.
   Tests: `test/ipc-contract.test.js`.
7. `main/tabs-controller.js`: `commandToActive`. Tests: `test/tabs-controller.test.js`.
8. `main/menu.js`: the File item (⇧⌘N). `main.js`: create the prefs, the cleanup (and `resume()`)
   and the service, and pass them to `createHandlers` and `createAppMenu`.
9. `main/smoke.js`: smoke support (§10 C5): seed `clone.json` `lastParent` in the throwaway
   userData from `PL_SMOKE_CLONE_PARENT`, which also answers "Choose where to clone".
   In a smoke run with no seed, the parent default is refused (kind `not-found`); it never falls
   back to the real home folder.

*Done when* the IPC, service, opening and quit-guard tests pass. The menu item does nothing visible
until C4: merge C3 and C4 together, or add the menu item in C4.

### C4: renderer
1. `renderer/dialog.js`: export `modal` and add `onDismiss`. Tests in `test/renderer-util.test.js`
   or a new `test/dialog.test.js`: a veto keeps the dialog open on Esc and on a backdrop press, and
   a forced close still closes it.
2. `renderer/clone.js` (new) and `renderer/clone.css`. `renderer/flows-kit.js`: export
   `authMessage` on `PLFlowKit`.
3. `renderer/components/repo-picker.js`: the Clone… buttons. `renderer/app.js`: the menu command
   and `resume()`.
4. `renderer/index.html`, `eslint.config.js` (`PLClone`), `test/renderer-harness.js`.
5. Tests: `test/clone-ui.test.js` on the fake DOM (§11.2), and additions to
   `test/repo-picker.test.js` (the buttons, the hint, the popover closing).

*Done when* the harness tests pass, and the smoke script (C5) clones from the start screen and shows
the repo view.

### C5: docs and QA
- **README**: "No clone or init" (line 149) becomes "No init". Clone goes into the features list and
  into "To open a repository" (line 127).
- **CHANGELOG** `[Unreleased] / Added`.
- **CONTRIBUTING.md** Architecture: one bullet for clone (the app op, the service, the persisted
  cleanup).
- **SECURITY.md**: the §8 note.
- **roadmap.md**: the §1.1 "Clone" row becomes Done (MVP), with a link to this plan.
- **`scripts/smoke-clone.js`**, like `scripts/smoke-image-preview.js`:
  - it builds bare fixtures in a temp folder, serves them over a smart-HTTP server on 127.0.0.1
    (`git http-backend` behind Node's `http`), and runs the app with `PL_SMOKE_CLONE_PARENT` (a
    temp folder)
  - it drives the dialog through `PL_SMOKE_JS`, typing the fixture's `http://127.0.0.1:<port>/…`
    URL: `exists`, success, and a cancel during "Updating files"
  - real remotes (GitHub over HTTPS and SSH) are covered by the manual QA
- **The manual QA** of §11.3 on macOS and Windows 11, written up as a flow table (steps, expected,
  observed, result), like the milestone 7 run.

---

## 11. Test plan

### 11.1 Unit and integration (automated, `node --test test/*.test.js`)

| Area | File | Covers |
|---|---|---|
| URL rules | `clone-url.test.js` | each kind per platform, local-source refusals, userinfo rules, `?` / `#`, `deriveName`, `nameError` |
| Name and text rules | `path-names.test.js`, `display-text.test.js` | `.git` aliases, device names, trailing dots and spaces; the invisible-character class |
| Progress parser | `clone-progress.test.js` | captured fixtures (with `bytes` units), byte-split chunks, `\r\n`, unknown lines, caps |
| spawnGit tap | `exec.test.js` | `onStderr` order, unchanged collection, a throwing listener |
| Error rules | `git-errors.test.js` | each new rule, anchored (no match on ref names or hook text) |
| Error catalogue | `error-kinds.test.js` | new kinds listed and used |
| Clone (real git) | `clone.test.js` | success (`file://`, local path, empty, the submodules flag), `checkout-failed` (`git mktree`, exit 128), every failure kind, the `mkdir` errors, cancel while connecting, cancel during "Updating files", the late cancel, redaction |
| Cleanup | `clone-cleanup.test.js` | the identity checks, persistence, `resume()`, a removal outlasting the quit bound, Windows hard-kill leftovers |
| Runner and quit | `ops.test.js`, `quit-guard.test.js` | the app op, cancel, the clone wording |
| Main use cases | `clone-service.test.js`, `repo-opening.test.js`, `recent.test.js` | §10 C3, including the tab and window closed mid-clone, and trust declined |
| IPC | `ipc-contract.test.js` | the channels, the coercer, events, the preload agreeing, no values in messages |
| UI | `clone-ui.test.js`, `repo-picker.test.js`, `dialog.test.js` | §11.2 |

No test touches the network. Remotes are bare repos over `file://` or local paths (called through
`cloneRepo` directly), plus local HTTP servers on 127.0.0.1 (401, 404, never answering), as
`test/git.test.js:643-660` already does.

### 11.2 Renderer harness cases (`clone-ui.test.js`)

- **The form**:
  - the name follows the URL until edited
  - an invalid URL disables Clone and shows the message
  - a typed local path asks for a remote URL, and there is no local-repository picker
  - Choose… shows the new parent display
  - Enter submits
- **Progress**:
  - frames for another opId are ignored
  - the phase text and the bar update
  - "Waiting…" after 30 s of fake time with no frame, with the auth hint for a URL source only
- **Cancel**:
  - the button calls `api.app.cancel(opId)` and disables itself
  - Esc and a backdrop click while running do nothing
  - the `aborted` rejection closes the dialog with the notice
  - a forced close (another `dialog.confirm`) doesn't cancel
- **Outcome**:
  - each error kind's title and text
  - the `leftover` toast
  - `stale` → Back shows main's current values
  - `checkout-failed` → Open Anyway calls `api.clone.openCloned(opId)`
  - `declined` and `openError` notices
- **Reattach**: `defaults()` with `running` reopens the progress modal for that opId.
- `menu-command 'clone'` opens the dialog, and is ignored while a dialog is open.
- All text goes through `textContent`: a URL with `<img>` in it shows as text.

### 11.3 Manual QA checklist

macOS (M) and Windows 11 (W). Each item is run on both unless marked otherwise.

| # | Case | Expected |
|---|---|---|
| 1 | Start screen → Clone… → public GitHub HTTPS URL | name derived, progress phases, the repo opens in the same tab, appears in Open Recent and the picker, the tab title updates |
| 2 | File > Clone Repository… (⇧⌘N / Ctrl+Shift+N) with a repo open | the dialog in that tab; the result opens in a new tab next to it |
| 3 | Private repo over HTTPS with the credential helper (osxkeychain / GCM) | works; on W, GCM's sign-in window appears and the clone goes on after sign-in |
| 4 | Private repo over HTTPS with no helper | "Authentication failed" with the platform's helper hint; no folder left |
| 5 | SSH with the key in the agent | works |
| 6 | SSH with a passphrase-protected key **not** in the agent | M: auth error quickly. W: record whether it fails or hangs (§9.3). With a hang, "Waiting…" appears after 30 s, Cancel works, and §9.3's BatchMode change is made for all remote ops |
| 7 | SSH to a host not in known_hosts | the `host-key` message |
| 8 | A typo in the host | `unreachable` |
| 9 | A non-existent repo on GitHub | `not-found` with the private-repo hint |
| 10 | Cancel at ~30% of a large repo (e.g. 1 GB), and once during "Updating files" | "Cancelling…", then "Clone cancelled"; the UI never freezes during removal; no folder left (W: including the read-only pack files) |
| 11 | Quit (⌘Q) during a clone, and during the removal of a large cancelled clone | the first asks with the clone wording, then no git process and no folder are left (or the folder is gone after the next launch); the second quits at once, and the next launch removes the rest |
| 12 | Close the tab during a clone | the close guard asks; Cancel and Close → the folder is removed |
| 13 | M: close the window (red button) during a clone | no question; the clone finishes; no window reappears; the repo is in Open Recent |
| 14 | The target folder already exists | `exists` with Back |
| 15 | W: clone into Documents with Controlled folder access on | `no-access` with the hint |
| 16 | Name `CON`, `x.`, `a:b` (W); `.git`, `..`, `a/b` (both) | refused inline |
| 17 | Typed `ext::sh -c touch /tmp/x`, `fd::3`, `-oProxyCommand=…`, `/tmp/r`, `file:///tmp/r`, `C:\r`, `\\server\share\r` | refused inline; nothing runs |
| 18 | `https://user:pass@host/r.git`, `https://ghp_…@github.com/…`, `https://h/r?private_token=x` | refused, with the reason |
| 19 | Typed `/tmp/r`, `C:\r` or a mapped drive path | "Enter a remote URL…" inline; there is no local-repository picker (remotes only) |
| 20 | A repo with submodules | the submodule notice; the submodule folders stay empty |
| 21 | An empty remote | opens with the unborn HEAD state |
| 22 | W: a repo with paths over 260 characters (no `core.longpaths`) | `checkout-failed`, and Open Anyway works |
| 23 | Reload the page (dev, View > Reload) mid-clone | the progress modal comes back; Cancel works |
| 24 | Reopen the dialog, also after a restart | the parent is the last one used |
| 25 | Help → Copy Diagnostics after a failed clone with a token-shaped URL typed | no secret in the text |
| 26 | VoiceOver (M) / Narrator (W) | the fields are labelled, the progress is announced, the errors are read |

---

## 12. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| SSH waiting on a hidden console on Windows (§9.3) | a clone that sits until cancelled | "Waiting…" + Cancel; QA row 6; BatchMode for all remote ops if it hangs (§13 Q5) |
| Progress format changes across git versions | a stuck or wrong bar (the clone itself still works) | a closed phase set; unknown frames ignored; fixtures captured with 2.51.2; the minimum git is pinned (`src/gitcheck.js:14`) |
| Removal failing on Windows after a hard kill (locked or read-only files) | a partial folder left | `maxRetries`; the identity check; pending entries retried at the next launch; `leftover` told to the user; the Windows CI test |
| Very large clones (tens of GB) | long runs; long removals | no timeout; the quit guard asks and kills; removal is async and resumable |
| Git LFS smudge during checkout | slow "Filtering content", an LFS auth failure, or requests to a host the repository names (§3.3) | shown as a phase; a failure is `checkout-failed` with git's text; the `.lfsconfig` redirect is documented as accepted |
| A user's `insteadOf` rewriting to a refused transport | an unexpected `unsupported` | explained in the dialog (§7.2) |
| Two tabs cloning to the same target | a race | the runner queue is keyed by the target, and `mkdir` is exclusive: the second one gets `exists` |
| Two tabs picking different parents | the wrong parent | `stale` on a display mismatch (§6.2) |
| Exporting `modal` widens the dialog API | inconsistent dialogs later | one builder, one new option with a narrow contract; `dialog.form` later (§2.2) |
| The app crashing mid-clone | a partial folder left | the clone's `Made` is written to `clone.json` as a pending removal as soon as the folder exists, and dropped when the clone succeeds (§15, review fixes); the next launch removes whatever a crash left, after the identity check |

---

## 13. Decisions (were open questions)

1. **Shortcut: ⇧⌘N / Ctrl+Shift+N.** No collision with `KEYS`, `VIEW_KEYS` or the main
   accelerators (checked, §6.7). ⌘N stays free for Init.
2. **Default parent: the last used parent, else the home folder.** There is no recent-list
   heuristic.
3. **An existing empty target folder is refused in the MVP** (`exists`). Supporting it later needs a
   cleanup that removes only what git wrote inside a folder we don't own.
4. **No `core.longpaths` in the MVP.** The app sets it nowhere, and enabling it for one repository
   while other tools on the machine can't handle long paths causes its own trouble. `checkout-failed`
   with "Filename too long" says what happened; offering the setting there is a possible follow-up
   (S).
5. **SSH BatchMode on Windows: only if QA row 6 shows the hang, and then for all remote ops** (fetch,
   pull, push, clone), via `-c core.sshCommand="ssh -o BatchMode=yes"`, only when `GIT_SSH`,
   `GIT_SSH_COMMAND` and `core.sshCommand` are all unset (§9.3).
6. **`http://` and `git://` are allowed, with a "not encrypted" note.** Self-hosted and LAN servers
   still use them, and git allows them.
7. **User names in URLs: allowed only if they match `^[A-Za-z0-9._-]{1,39}$` and aren't
   token-shaped.** Passwords are refused, and so are `?` and `#` in http(s) URLs (§5.1).
8. **Remote-helper URLs** (`codecommit://`, `hg::`, `persistent-https://` …) **are refused** (decision
   4). This can be revisited per helper if a user asks.

Further decisions from the review:
- **No local sources** (decision 1; first a folder dialog, removed after user testing, §15).
- **`protocol.file.allow=user`** (decision 4).
- **A clone whose tab closed finishes and is added to recent, not opened** (§6.4).
- **Removal is asynchronous, separate from the op, and resumable** (§5.5).
- **`app:openCloned` is kept** for Open Anyway after `checkout-failed`, with a single opId-keyed slot
  (§6.2).
- **`app:cloneCheck` is dropped**: `mkdir` reports `exists`.

---

## 14. Acceptance criteria

1. **Entry points.** From a New Tab, File > Clone Repository… (⇧⌘N), the start screen's Clone… and
   the picker's Clone… each open the dialog. Cloning a public HTTPS repository shows its progress
   phases and opens the repo in that tab, listed in Open Recent and the picker.
2. **Placement.** From a tab with a repo open, the clone opens in a new tab next to it. If the
   clone's tab or window closed meanwhile, the clone is not opened, no window appears, and the
   repository is in the recent list. A declined Trust and Open asks once and leaves the clone on
   disk, with a notice.
3. **Cancel.** Cancel at any point, including during "Updating files", leaves no folder behind on
   macOS and Windows and no git process running, and the main process never blocks while the folder
   is removed.
4. **Quit and close.** Quitting or closing the tab during a clone asks first, with clone wording. A
   removal interrupted by a quit finishes at the next launch, and only for the same folder.
5. **Failures.** Each failure (auth, host key, not found, unreachable, folder exists, no access, no
   space, path too long, unsupported URL, changed parent) shows its own explanation, with no folder
   left behind. `checkout-failed` keeps the clone and offers Open Anyway. A clone that succeeded but
   can't be opened says so.
6. **No secrets.** No secret from the URL (password, token) appears in a log, in Copy Diagnostics,
   in an error message or in the dialog. Such URLs, and http(s) URLs with `?` or `#`, are refused
   before git runs.
7. **No paths from the page.** The page never sends a filesystem path or names a local source:
   `test/ipc-contract.test.js` shows the clone channels accept only a typed network URL, a
   single-segment name, main's own display strings for the `stale` check, and an
   opId. Typed local paths, `file://`, UNC and device paths are refused.
8. **No helper transports.** `ext::`, `fd::`, other `<helper>::` URLs and `-`-prefixed URLs never
   reach a git that could run them: they are refused by validation, and by `protocol.allow=never` if
   validation were bypassed. `protocol.file.allow` stays `user`.
9. **Reload.** A page reload mid-clone reattaches to its progress and Cancel.
10. **Remembered parent.** The parent folder last used is offered again, also after a restart.
11. **Green CI.** `npm test` and `npm run lint` pass on macOS, Ubuntu and Windows CI, with the new
    tests of §11.

---

## 15. Implementation notes (where the build differs)

Recorded while building C1–C5; none changes a decision of §1.2 or §13.

**Phasing.**
- `createClonePrefs` (`src/recent.js`) and the async JSON pair (`src/json-file.js`) landed in C2,
  not C3: the cleanup persists through them, and its tests need the real `clone.json`.
- The File menu item landed in C3 with the rest of main; C3 and C4 are on the same branch, so it is
  never visible without the dialog.

**Parsing and classification (C1, C2).**
- The progress pattern also accepts a count without a total (`Enumerating objects: 35, done.`,
  `Checking connectivity: N, done.`: git 2.51.2 prints the first for every clone over `file://`),
  and a phase name alone is no frame. git pads `remote:` frames with trailing spaces, which are
  trimmed before matching (seen in the captured stderr).
- `remoteNotFound` also matches `fatal: '<x>' does not appear to be a git repository`: what a
  missing `file://` repository (and a plain upload-pack over ssh) prints. `unreachable` also matches
  git://'s `unable to look up` / `unable to connect to` and ssh's `Connection timed out`.
- An error's message leaves out git's `Cloning into '<target>'...` line (our own target, not news).
- `parseCloneUrl(text)` takes no `{platform}`: its rules are the same everywhere by design (a
  Windows path is refused on macOS too). `deriveName` and `nameError` take it. `nameError` also
  refuses invisible and control characters, and `.git` on every platform (as §4.3 and QA row 16 say).
- An scp-like URL whose host is one letter is refused with a user too (`git@h:r`: "The host name is
  too short"); without one it is a drive path (§5.1 step 2).
- The small-transfer fixture with `bytes` units is written by hand in git's format (a transfer that
  small never runs long enough for git to print its throughput); the others are captured from
  2.51.2, plus a 61 MiB transfer's frames with `MiB` throughput.

**Tests (C2).**
- "Cancel during Updating files" clones a repository of 300 files with a slow smudge filter from the
  test's own global config (`sleep 0.02; cat`), instead of ~20,000 files: the phase then lasts
  seconds on any disk, so git always shows it. The smoke script's cancel run does the same.

**Main (C3).**
- The service hands the runner `{source, parent, name}`, the source a URL `cloneCheck` checks again
  with `parseCloneUrl`. Its hooks are `onProgress` and `onMade` (the journal entry, see the
  review fixes below).
- `app:cloneDefaults` and `app:pickCloneParent` return the parent as `{display, chars}`: `chars`, the
  absolute path's length, lets the form warn about Windows' long paths (§9.2) without a path
  crossing to the page. A smoke run without a seed has no parent (`null`), and `app:clone` refuses
  it with `not-found`.
- A clone whose tab closed is put in the recent list by `repo-opening`'s new `rememberRecent(dir)`
  (it holds the recent store and the menu's refresh), so the service takes no `recent`.

**Page (C4).**
- The `clone-progress` subscription lives for the page (one listener), so the later
  `cleanup: 'failed'` event is heard after the dialog closed; frames of another opId are ignored.
- The menu command goes through `PLClone.fromMenu` (it stands down while a dialog or menu is open),
  so the rule is unit-tested; `app.js` calls it.
- A page reattached after a reload has no `app:clone` reply to wait for: it asks
  `app:cloneDefaults` once a second until the clone no longer runs, then reports the tab's last
  outcome main recorded (`last`, see the review fixes below); a clone that opened here shows
  itself through `repo-opened` as before.
- The repository picker's two Clone… buttons go through `PLRepoPicker.cloneRepo`, which looks
  `window.PLClone` up when used (`clone.js` loads after the picker).

**Review fixes (after C5).**
- The folder is journalled in `clone.json` from `onMade` (`cleanup.journal`) as soon as it exists,
  and dropped when the clone succeeds or keeps its folder after a checkout failure
  (`cleanup.forget`), not only once a failure settled: a quit approved while git still runs (even
  one that outlived its kill: the UNSAFE "Quit") or a crash no longer abandons it. `before-quit`
  waits for those writes, at most 2 s (`cleanup.persisted()`, like the thumbnailer's wait). This
  closes §12's last row.
- A new clone's folder replaces every pending entry for the same path, and the identity check also
  compares the folder's birth time (`birthtimeNs`), so a reused inode never makes `resume()` delete
  a later folder. Where the file system keeps no birth time (0) or reports the ctime in its place,
  dev and inode decide alone: a directory's ctime moves with every entry git writes, so it can't
  stand in for a birth time.
- `app:cloneDefaults` also returns `last`, how this tab's last clone ended (with what
  `errorView` needs). A reattached page reports that, and only that: never another tab's `changed`
  event; attaching again stops the earlier poll loop.
- The tab's running entry is set before `app:clone` awaits anything (a second submit is refused at
  once), and `app:cancel` reaches a clone still in its checks through `cancelPending`.
- Refusals about the parent say so: `not-found` and `stale` carry `state: 'parent'`.
- An error's and a checkout failure's message are always ours, redacted and at most 2,000
  characters, without "Cloning into"; a GitError's own text (its command line with the URL when
  git said nothing) never reaches the page.
- `unreachable` also matches curl's dropped connections (`Recv failure`, `Send failure`, `Empty
  reply from server`); the test uses a server that drops the connection instead of a freed port.
- A clone whose tab closed goes to the recent list without blocking (`recent.addAsync`). Its
  writes run one after another, but a synchronous `add()` from another open in the same moment can
  still land between its read and its write: at worst that entry drops out of the list.

**Local source removed after user testing.** The build had a "Choose Local Repository…" button:
main's folder dialog picked a local repository, main kept its path in a slot (`app:pickCloneSource`),
and the page sent `{source: 'picked'}` with its display. In testing the user picked a folder that
wasn't a repository, got git's raw "repository … does not exist", and asked what cloning a local
folder is for (open it, or copy it, instead). The decision was to remove it rather than add
validation: clone is remotes only. Gone: the button, the channel (four clone channels remain), the
service's slot, the request's `source` field (it is `{url, name, parent}`), the runner request's
`local` flag (`cloneCheck` always requires a network URL), the stale `state: 'source'` and its Back
handling, and the page's picked-source paths (the "Waiting…" hint now applies to every clone).
A typed local path now reads "Enter a remote URL (https://…, ssh://…, git@host:…)". `cloneRepo`
itself still clones local paths and `file://` URLs, for the tests' fixtures (it is never handed one
by the app), so `protocol.file.allow` stays `user`. The smoke script, which relied on the picker,
serves its fixtures over a local smart-HTTP server (`git http-backend` behind Node's `http` on
127.0.0.1) and types that URL: the app's URL rules and transport allowlist apply as for any remote,
and nothing in the app is relaxed for smoke runs.

**Not done in this build.**
- The manual QA of §11.3 (macOS and Windows 11), including row 6, which decides §13 Q5's BatchMode
  change for Windows; the Windows-only cleanup test runs in CI's Windows job.
